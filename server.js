// Al correrlo en tu computadora, lee las variables del archivo .env si existe
// (en Railway se cargan en la pestaña "Variables").
if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch { /* no hay archivo .env */ }
}

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { all, get, run, tx, config, guardarConfig, CLAVES_CONFIG } = require('./db');
const Validar = require('./public/validar');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const SECRET = process.env.SESSION_SECRET || config().secreto_sesion;
const HORAS_ACCESO = 6;
const DIAS_CLIENTE = 30;
const HORAS_ADMIN = 12;
const ESTADOS = ['pendiente', 'aprobado', 'rechazado', 'pagado'];
const METODOS_PAGO = ['transferencia', 'mercadopago', 'ambos'];
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

if (!ADMIN_PASSWORD) {
  console.warn('[aviso] Falta ADMIN_PASSWORD: el panel queda desactivado hasta que la configures.');
} else if (ADMIN_PASSWORD.length < 8) {
  console.warn('[aviso] ADMIN_PASSWORD es muy corta: usá al menos 8 caracteres.');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilidades ----------

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const id = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const ahora = () => new Date().toISOString();

// Las llamadas que cambian datos tienen que venir de la propia página (JSON).
app.use('/api', (req, _res, next) => {
  const esJson = String(req.headers['content-type'] || '').startsWith('application/json');
  if (req.method !== 'GET' && req.path !== '/pagos/webhook' && !esJson) {
    return next(new HttpError(415, 'Formato no soportado.'));
  }
  req.body ??= {};
  next();
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

// Límite de intentos por IP (para que el código no se pueda adivinar probando, y contra spam).
function rateLimiter(max, windowMinutes) {
  const hits = new Map();
  return {
    check(ip) {
      const now = Date.now();
      const entry = hits.get(ip);
      if (!entry || now > entry.reset) {
        hits.set(ip, { count: 1, reset: now + windowMinutes * 60 * 1000 });
        return;
      }
      entry.count += 1;
      if (entry.count > max) throw new HttpError(429, 'Muchos intentos seguidos. Esperá unos minutos.');
    },
    clear(ip) {
      hits.delete(ip);
    },
  };
}

const limiteAcceso = rateLimiter(8, 15);
const limiteRegistro = rateLimiter(30, 15);
const limitePedidos = rateLimiter(20, 15);
const limiteAdmin = rateLimiter(10, 15);

function codigoPedidoNuevo() {
  let codigo;
  do {
    codigo = [...crypto.randomBytes(6)].map((b) => ALFABETO[b % ALFABETO.length]).join('');
  } while (get('SELECT 1 FROM pedidos WHERE codigo = ?', codigo));
  return codigo;
}

function urlBase(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// ---------- Fiestas ----------

const registrosDe = (eventoId) => get('SELECT COUNT(*) AS n FROM lista_rrpp WHERE evento_id = ?', eventoId).n;

function eventoPublico(e) {
  return {
    id: e.id,
    nombre: e.nombre,
    fecha: e.fecha,
    descripcion: e.descripcion,
    lleno: e.cupo > 0 && registrosDe(e.id) >= e.cupo,
  };
}

function eventoAbierto(eventoId) {
  const evento = get('SELECT * FROM eventos WHERE id = ? AND abierto = 1', id(eventoId));
  if (!evento) throw new HttpError(400, 'Esa fecha no está disponible.');
  return evento;
}

// ---------- Acceso (código) y cliente (registro) ----------

function leerAcceso(req) {
  const sesion = unsign(getCookie(req, 'acceso'));
  if (!sesion) return null;
  if (sesion.rrppId === null) return config().permitir_sin_rrpp ? { rrpp: null } : null;
  const rrpp = get('SELECT * FROM rrpp WHERE id = ? AND activo = 1', id(sesion.rrppId));
  return rrpp ? { rrpp } : null;
}

function leerCliente(req) {
  const sesion = unsign(getCookie(req, 'cliente'));
  return (sesion && get('SELECT * FROM clientes WHERE id = ?', id(sesion.clienteId))) || null;
}

function exigirAcceso(req) {
  const acceso = leerAcceso(req);
  if (!acceso) throw new HttpError(401, 'Sin código no se pasa.', { motivo: 'acceso' });
  return acceso;
}

function exigirCliente(req) {
  const cliente = leerCliente(req);
  if (!cliente) throw new HttpError(401, 'Primero registrate.', { motivo: 'registro' });
  return cliente;
}

function darAcceso(req, res, rrppId) {
  setCookie(req, res, 'acceso', sign({ rrppId, exp: Date.now() + HORAS_ACCESO * 3600 * 1000 }), HORAS_ACCESO * 3600);
}

// Anota al cliente en la lista del RRPP para esa fecha (una sola vez por fecha: gana el primer RRPP).
function anotar(cliente, rrpp, evento) {
  if (get('SELECT 1 FROM lista_rrpp WHERE cliente_id = ? AND evento_id = ?', cliente.id, evento.id)) return;
  if (evento.cupo > 0 && registrosDe(evento.id) >= evento.cupo) throw new HttpError(409, 'Se llenó el cupo de esta fecha.');
  run('INSERT INTO lista_rrpp (cliente_id, rrpp_id, evento_id) VALUES (?, ?, ?)', cliente.id, rrpp?.id ?? null, evento.id);
  if (rrpp && !cliente.rrpp_id) run('UPDATE clientes SET rrpp_id = ? WHERE id = ?', rrpp.id, cliente.id);
}

function eventoDelCliente(cliente, eventoId) {
  const evento = eventoAbierto(eventoId);
  if (!get('SELECT 1 FROM lista_rrpp WHERE cliente_id = ? AND evento_id = ?', cliente.id, evento.id)) {
    throw new HttpError(403, 'Primero registrate para esta fecha.', { motivo: 'registro' });
  }
  return evento;
}

app.get('/api/config', (_req, res) => {
  const c = config();
  res.json({
    nombre_lugar: c.nombre_lugar,
    texto_puerta_1: c.texto_puerta_1,
    texto_puerta_2: c.texto_puerta_2,
    texto_pie: c.texto_pie,
    instagram: c.instagram,
    edad_minima: c.edad_minima,
    permitir_sin_rrpp: c.permitir_sin_rrpp,
    consentimiento: c.consentimiento.replaceAll('{lugar}', c.nombre_lugar),
  });
});

app.post('/api/acceso', (req, res) => {
  limiteAcceso.check(req.ip);
  const codigo = Validar.codigo(req.body.codigo);
  const rrpp = codigo && get('SELECT * FROM rrpp WHERE codigo = ? AND activo = 1', codigo);
  if (!rrpp) throw new HttpError(401, 'No es ese. Preguntale a quien te lo pasó.');
  limiteAcceso.clear(req.ip);
  darAcceso(req, res, rrpp.id);
  res.json({ ok: true });
});

app.post('/api/acceso/sin-rrpp', (req, res) => {
  if (!config().permitir_sin_rrpp) throw new HttpError(403, 'Por ahora solo se entra con código.');
  darAcceso(req, res, null);
  res.json({ ok: true });
});

// Qué tiene que ver el visitante: la puerta, el registro o el catálogo.
app.get('/api/sesion', (req, res) => {
  const acceso = leerAcceso(req);
  const cliente = leerCliente(req);
  res.json({
    acceso: Boolean(acceso),
    cliente: cliente && { nombre: cliente.nombre },
    eventos: acceso ? all('SELECT * FROM eventos WHERE abierto = 1 ORDER BY fecha').map(eventoPublico) : [],
    anotado: cliente ? all('SELECT evento_id FROM lista_rrpp WHERE cliente_id = ?', cliente.id).map((r) => r.evento_id) : [],
  });
});

app.post('/api/registro', (req, res) => {
  limiteRegistro.check(req.ip);
  const acceso = exigirAcceso(req);
  const evento = eventoAbierto(req.body.evento_id);
  const { valores, errores } = Validar.registro(req.body, { edadMinima: config().edad_minima, referencia: evento.fecha });
  if (errores) throw new HttpError(400, 'Revisá los datos marcados.', { campos: errores });

  // Si el teléfono ya existe se reutiliza el cliente, pero solo si coincide el cumpleaños:
  // así nadie puede registrarse con el número de otra persona.
  let cliente = get('SELECT * FROM clientes WHERE telefono = ?', valores.telefono);
  if (cliente && cliente.cumpleanos !== valores.cumpleanos) {
    throw new HttpError(409, 'Ese teléfono ya está registrado con otra fecha de cumpleaños. Revisala o escribinos.', {
      campos: { cumpleanos: 'No coincide con la que registraste antes con este teléfono.' },
    });
  }
  const reutilizado = Boolean(cliente);
  tx(() => {
    if (!cliente) {
      const { lastInsertRowid } = run(
        `INSERT INTO clientes (nombre, instagram, cumpleanos, telefono, rrpp_id, evento_id, consentimiento_en)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        valores.nombre, valores.instagram, valores.cumpleanos, valores.telefono, acceso.rrpp?.id ?? null, evento.id, ahora(),
      );
      cliente = get('SELECT * FROM clientes WHERE id = ?', lastInsertRowid);
    }
    anotar(cliente, acceso.rrpp, evento);
  });
  setCookie(req, res, 'cliente', sign({ clienteId: cliente.id, exp: Date.now() + DIAS_CLIENTE * 86400 * 1000 }), DIAS_CLIENTE * 86400);
  res.status(201).json({ cliente: { nombre: cliente.nombre }, reutilizado });
});

// Un cliente ya registrado que vuelve (con código) y se anota para una fecha.
app.post('/api/lista', (req, res) => {
  const acceso = exigirAcceso(req);
  const cliente = exigirCliente(req);
  const evento = eventoAbierto(req.body.evento_id);
  const { edad_minima: edadMinima } = config();
  if (Validar.edad(cliente.cumpleanos, evento.fecha) < edadMinima) {
    throw new HttpError(400, `Para esta fecha tenés que tener ${edadMinima} años o más.`);
  }
  tx(() => anotar(cliente, acceso.rrpp, evento));
  res.json({ ok: true });
});

app.post('/api/salir', (req, res) => {
  setCookie(req, res, 'cliente', '', 0);
  res.json({ ok: true });
});

// ---------- Catálogo y pedidos ----------

app.get('/api/catalogo', (req, res) => {
  exigirAcceso(req);
  const evento = eventoDelCliente(exigirCliente(req), req.query.evento_id);
  const { recargo } = config();
  const productos = all('SELECT id, nombre, descripcion, precio FROM productos WHERE activo = 1 ORDER BY orden, id')
    .map((p) => ({ ...p, recargo, total: p.precio + recargo }));
  res.json({ evento: eventoPublico(evento), recargo, productos });
});

app.post('/api/pedidos', (req, res) => {
  limitePedidos.check(req.ip);
  exigirAcceso(req);
  const cliente = exigirCliente(req);
  const evento = eventoDelCliente(cliente, req.body.evento_id);
  const { recargo } = config();

  const cantidades = new Map();
  for (const item of Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : []) {
    const productoId = id(item?.producto_id);
    const cantidad = Number(item?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1) throw new HttpError(400, 'Revisá las cantidades.');
    cantidades.set(productoId, (cantidades.get(productoId) || 0) + cantidad);
  }
  if (!cantidades.size) throw new HttpError(400, 'Elegí al menos un producto.');

  const items = [...cantidades].map(([productoId, cantidad]) => {
    const producto = get('SELECT * FROM productos WHERE id = ? AND activo = 1', productoId);
    if (!producto) throw new HttpError(400, 'Uno de los productos ya no está disponible. Actualizá la página.');
    if (cantidad > 10) throw new HttpError(400, `Máximo 10 de ${producto.nombre} por pedido.`);
    const subtotal = (producto.precio + recargo) * cantidad;
    return { producto_id: producto.id, nombre: producto.nombre, precio: producto.precio, recargo, cantidad, subtotal };
  });
  const total = items.reduce((suma, i) => suma + i.subtotal, 0);
  const { rrpp_id: rrppId } = get('SELECT rrpp_id FROM lista_rrpp WHERE cliente_id = ? AND evento_id = ?', cliente.id, evento.id);

  const pedido = tx(() => {
    const { lastInsertRowid } = run(
      'INSERT INTO pedidos (codigo, token, cliente_id, rrpp_id, evento_id, total) VALUES (?, ?, ?, ?, ?, ?)',
      codigoPedidoNuevo(), crypto.randomBytes(16).toString('hex'), cliente.id, rrppId, evento.id, total,
    );
    for (const i of items) {
      run(
        'INSERT INTO pedido_items (pedido_id, producto_id, nombre, precio, recargo, cantidad, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)',
        lastInsertRowid, i.producto_id, i.nombre, i.precio, i.recargo, i.cantidad, i.subtotal,
      );
    }
    return get('SELECT * FROM pedidos WHERE id = ?', lastInsertRowid);
  });
  res.status(201).json({ pedido: vistaCliente(pedido) });
});

const itemsDe = (pedidoId) => all(
  'SELECT producto_id, nombre, precio, recargo, cantidad, subtotal FROM pedido_items WHERE pedido_id = ? ORDER BY id',
  pedidoId,
);

const usaMercadoPago = (c) => Boolean(MP_TOKEN) && ['mercadopago', 'ambos'].includes(c.metodo_pago);

// Lo que ve el cliente de su pedido. La dirección y los datos de pago aparecen recién cuando corresponde.
function vistaCliente(pedido) {
  const c = config();
  const evento = get('SELECT nombre, fecha, direccion FROM eventos WHERE id = ?', pedido.evento_id);
  const vista = {
    id: pedido.id,
    token: pedido.token,
    codigo: pedido.codigo,
    estado: pedido.estado,
    total: pedido.total,
    creado_en: pedido.creado_en,
    ingreso: Boolean(pedido.ingreso_en),
    cliente: get('SELECT nombre FROM clientes WHERE id = ?', pedido.cliente_id),
    evento: { nombre: evento.nombre, fecha: evento.fecha, direccion: pedido.estado === 'pagado' ? evento.direccion : null },
    items: itemsDe(pedido.id),
    whatsapp: c.whatsapp || null,
    pago: null,
  };
  if (pedido.estado === 'aprobado') {
    const conTransferencia = c.metodo_pago !== 'mercadopago' || !MP_TOKEN;
    vista.pago = {
      mercadopago: usaMercadoPago(c) ? pedido.mp_link : null,
      transferencia: conTransferencia && (c.transferencia_alias || c.transferencia_cbu)
        ? { alias: c.transferencia_alias, cbu: c.transferencia_cbu, titular: c.transferencia_titular }
        : null,
    };
  }
  return vista;
}

async function crearLinkMercadoPago(pedido, req) {
  const base = urlBase(req);
  const vuelta = `${base}/?pedido=${pedido.id}&t=${pedido.token}`;
  try {
    const respuesta = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: itemsDe(pedido.id).map((i) => ({
          title: i.nombre, quantity: i.cantidad, unit_price: i.precio + i.recargo, currency_id: 'ARS',
        })),
        external_reference: String(pedido.id),
        back_urls: { success: vuelta, pending: vuelta, failure: vuelta },
        auto_return: 'approved',
        notification_url: `${base}/api/pagos/webhook`,
      }),
    });
    if (!respuesta.ok) {
      console.error('Mercado Pago no creó el link de pago:', respuesta.status, await respuesta.text());
      return;
    }
    const { init_point: link } = await respuesta.json();
    if (link) run("UPDATE pedidos SET mp_link = ? WHERE id = ? AND estado = 'aprobado'", link, pedido.id);
  } catch (err) {
    console.error('No se pudo crear el link de Mercado Pago:', err);
  }
}

const creandoLink = new Set();

app.get('/api/pedidos/:id', async (req, res) => {
  let pedido = get('SELECT * FROM pedidos WHERE id = ?', id(req.params.id));
  if (!pedido || !safeEqual(pedido.token, String(req.query.t || ''))) throw new HttpError(404, 'No encontramos ese pedido.');
  // El link de Mercado Pago se crea la primera vez que el cliente abre un pedido aprobado.
  if (pedido.estado === 'aprobado' && !pedido.mp_link && usaMercadoPago(config()) && !creandoLink.has(pedido.id)) {
    creandoLink.add(pedido.id);
    try {
      await crearLinkMercadoPago(pedido, req);
    } finally {
      creandoLink.delete(pedido.id);
    }
    pedido = get('SELECT * FROM pedidos WHERE id = ?', pedido.id);
  }
  res.json({ pedido: vistaCliente(pedido) });
});

// Aviso de Mercado Pago: se confirma el pago consultando su API (no se confía en el aviso en sí).
app.post('/api/pagos/webhook', async (req, res) => {
  res.sendStatus(200);
  const tipo = req.body?.type || req.query.type || req.query.topic;
  const pagoId = req.body?.data?.id || req.query['data.id'] || req.query.id;
  if (!MP_TOKEN || tipo !== 'payment' || !pagoId) return;
  try {
    const respuesta = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(pagoId)}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!respuesta.ok) return;
    const pago = await respuesta.json();
    const pedido = get('SELECT * FROM pedidos WHERE id = ?', id(pago.external_reference));
    if (!pedido || pedido.estado === 'pagado') return;
    if (pago.status !== 'approved' || pago.currency_id !== 'ARS' || Number(pago.transaction_amount) < pedido.total) return;
    run("UPDATE pedidos SET estado = 'pagado', pagado_en = ?, mp_pago_id = ? WHERE id = ?", ahora(), String(pago.id), pedido.id);
  } catch (err) {
    console.error('Error procesando el aviso de Mercado Pago:', err);
  }
});

// ---------- Panel ----------

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) throw new HttpError(503, 'El panel está desactivado: falta configurar ADMIN_PASSWORD.');
  limiteAdmin.check(req.ip);
  if (!safeEqual(String(req.body.password || ''), ADMIN_PASSWORD)) throw new HttpError(401, 'Contraseña incorrecta.');
  limiteAdmin.clear(req.ip);
  setCookie(req, res, 'admin', sign({ admin: true, exp: Date.now() + HORAS_ADMIN * 3600 * 1000 }), HORAS_ADMIN * 3600);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(req, res, 'admin', '', 0);
  res.json({ ok: true });
});

const admin = express.Router();
admin.use((req, _res, next) => {
  if (!unsign(getCookie(req, 'admin'))?.admin) throw new HttpError(401, 'Iniciá sesión.');
  next();
});

admin.get('/me', (_req, res) => res.json({ ok: true }));

// Búsqueda sin importar tildes ni mayúsculas.
function filtrar(filas, texto, campos) {
  const buscado = Validar.plano(str(texto, 60));
  if (!buscado) return filas;
  return filas.filter((f) => campos.some((campo) => Validar.plano(f[campo]).includes(buscado)));
}

// --- Pedidos ---

const ETIQUETAS = { pendiente: 'pendiente', aprobado: 'aprobado', rechazado: 'rechazado', pagado: 'pagado' };

const SQL_PEDIDOS = `
  SELECT p.*, c.nombre AS cliente_nombre, c.instagram, c.telefono,
         r.nombre AS rrpp_nombre, e.nombre AS evento_nombre, e.fecha AS evento_fecha
  FROM pedidos p
  JOIN clientes c ON c.id = p.cliente_id
  JOIN eventos e ON e.id = p.evento_id
  LEFT JOIN rrpp r ON r.id = p.rrpp_id`;

const vistaAdmin = (p) => ({ ...p, items: itemsDe(p.id) });

admin.get('/pedidos', (req, res) => {
  const estado = ESTADOS.includes(req.query.estado) ? req.query.estado : '';
  const eventoId = id(req.query.evento_id);
  const filas = all(
    `${SQL_PEDIDOS} WHERE (? = '' OR p.estado = ?) AND (? = 0 OR p.evento_id = ?) ORDER BY p.id DESC`,
    estado, estado, eventoId, eventoId,
  );
  const pedidos = filtrar(filas, req.query.q, ['cliente_nombre', 'instagram', 'telefono', 'codigo', 'rrpp_nombre'])
    .slice(0, 300)
    .map(vistaAdmin);
  const resumen = get(
    `SELECT COALESCE(SUM(estado = 'pendiente'), 0) AS pendientes,
            COALESCE(SUM(CASE WHEN estado = 'aprobado' THEN total END), 0) AS por_cobrar,
            COALESCE(SUM(CASE WHEN estado = 'pagado' THEN total END), 0) AS cobrado
     FROM pedidos WHERE (? = 0 OR evento_id = ?)`,
    eventoId, eventoId,
  );
  res.json({ pedidos, resumen });
});

admin.post('/pedidos/:id/:accion', (req, res) => {
  const pedido = get('SELECT * FROM pedidos WHERE id = ?', id(req.params.id));
  if (!pedido) throw new HttpError(404, 'Pedido no encontrado.');
  const exigir = (...estados) => {
    if (!estados.includes(pedido.estado)) throw new HttpError(409, `No se puede: el pedido está ${ETIQUETAS[pedido.estado]}.`);
  };
  switch (req.params.accion) {
    case 'aprobar':
      exigir('pendiente');
      run("UPDATE pedidos SET estado = 'aprobado', decidido_en = ? WHERE id = ?", ahora(), pedido.id);
      break;
    case 'rechazar':
      exigir('pendiente');
      run("UPDATE pedidos SET estado = 'rechazado', decidido_en = ? WHERE id = ?", ahora(), pedido.id);
      break;
    case 'pendiente': // deshacer una aprobación o un rechazo
      exigir('aprobado', 'rechazado');
      run("UPDATE pedidos SET estado = 'pendiente', decidido_en = NULL WHERE id = ?", pedido.id);
      break;
    case 'pagado': // pago por transferencia, confirmado a mano
      exigir('aprobado');
      run("UPDATE pedidos SET estado = 'pagado', pagado_en = ? WHERE id = ?", ahora(), pedido.id);
      break;
    case 'ingreso':
      exigir('pagado');
      run('UPDATE pedidos SET ingreso_en = ? WHERE id = ?', req.body.deshacer ? null : ahora(), pedido.id);
      break;
    default:
      throw new HttpError(404, 'Acción desconocida.');
  }
  res.json({ pedido: vistaAdmin(get(`${SQL_PEDIDOS} WHERE p.id = ?`, pedido.id)) });
});

// --- Productos ---

function productoDesde(b, previo = {}) {
  const nombre = str(b.nombre ?? previo.nombre, 60);
  if (!nombre) throw new HttpError(400, 'El producto necesita un nombre.');
  const precio = Validar.pesos(b.precio ?? previo.precio);
  if (Number.isNaN(precio) || precio > 100_000_000) throw new HttpError(400, 'El precio tiene que ser un monto en pesos, sin centavos.');
  const orden = Number(b.orden ?? previo.orden ?? 0);
  return {
    nombre,
    descripcion: str(b.descripcion ?? previo.descripcion ?? '', 200),
    precio,
    activo: (b.activo ?? previo.activo ?? true) ? 1 : 0,
    orden: Number.isInteger(orden) ? orden : 0,
  };
}

admin.get('/productos', (_req, res) => {
  const { recargo } = config();
  const productos = all('SELECT * FROM productos ORDER BY orden, id').map((p) => ({ ...p, total: p.precio + recargo }));
  res.json({ productos, recargo });
});

admin.post('/productos', (req, res) => {
  const p = productoDesde(req.body);
  const { lastInsertRowid } = run(
    'INSERT INTO productos (nombre, descripcion, precio, activo, orden) VALUES (?, ?, ?, ?, ?)',
    p.nombre, p.descripcion, p.precio, p.activo, p.orden,
  );
  res.status(201).json({ producto: get('SELECT * FROM productos WHERE id = ?', lastInsertRowid) });
});

admin.put('/productos/:id', (req, res) => {
  const previo = get('SELECT * FROM productos WHERE id = ?', id(req.params.id));
  if (!previo) throw new HttpError(404, 'Producto no encontrado.');
  const p = productoDesde(req.body, previo);
  run('UPDATE productos SET nombre = ?, descripcion = ?, precio = ?, activo = ?, orden = ? WHERE id = ?',
    p.nombre, p.descripcion, p.precio, p.activo, p.orden, previo.id);
  res.json({ producto: get('SELECT * FROM productos WHERE id = ?', previo.id) });
});

admin.delete('/productos/:id', (req, res) => {
  const { changes } = run('DELETE FROM productos WHERE id = ?', id(req.params.id));
  if (!changes) throw new HttpError(404, 'Producto no encontrado.');
  res.json({ ok: true });
});

// --- RRPP ---

function rrppDesde(b, previo = {}) {
  const nombre = str(b.nombre ?? previo.nombre, 60);
  if (!nombre) throw new HttpError(400, 'El RRPP necesita un nombre.');
  const codigo = Validar.codigo(b.codigo ?? previo.codigo);
  if (!/^[A-Z0-9_-]{3,30}$/.test(codigo)) {
    throw new HttpError(400, 'El código tiene que tener entre 3 y 30 letras o números, sin espacios.');
  }
  if (get('SELECT 1 FROM rrpp WHERE codigo = ? AND id != ?', codigo, previo.id ?? 0)) {
    throw new HttpError(409, 'Ese código ya lo usa otro RRPP.');
  }
  return { nombre, codigo, activo: (b.activo ?? previo.activo ?? true) ? 1 : 0 };
}

admin.get('/rrpp', (_req, res) => {
  const rrpp = all(`
    SELECT r.*,
      (SELECT COUNT(*) FROM lista_rrpp l WHERE l.rrpp_id = r.id) AS anotados,
      (SELECT COUNT(*) FROM pedidos p WHERE p.rrpp_id = r.id) AS pedidos,
      (SELECT COALESCE(SUM(total), 0) FROM pedidos p WHERE p.rrpp_id = r.id AND p.estado = 'pagado') AS cobrado
    FROM rrpp r ORDER BY r.activo DESC, r.nombre`);
  res.json({ rrpp });
});

admin.post('/rrpp', (req, res) => {
  const r = rrppDesde(req.body);
  const { lastInsertRowid } = run('INSERT INTO rrpp (nombre, codigo, activo) VALUES (?, ?, ?)', r.nombre, r.codigo, r.activo);
  res.status(201).json({ rrpp: get('SELECT * FROM rrpp WHERE id = ?', lastInsertRowid) });
});

admin.put('/rrpp/:id', (req, res) => {
  const previo = get('SELECT * FROM rrpp WHERE id = ?', id(req.params.id));
  if (!previo) throw new HttpError(404, 'RRPP no encontrado.');
  const r = rrppDesde(req.body, previo);
  run('UPDATE rrpp SET nombre = ?, codigo = ?, activo = ? WHERE id = ?', r.nombre, r.codigo, r.activo, previo.id);
  res.json({ rrpp: get('SELECT * FROM rrpp WHERE id = ?', previo.id) });
});

admin.delete('/rrpp/:id', (req, res) => {
  const rrppId = id(req.params.id);
  const usado = get(`SELECT 1 WHERE EXISTS (SELECT 1 FROM clientes WHERE rrpp_id = ?)
    OR EXISTS (SELECT 1 FROM lista_rrpp WHERE rrpp_id = ?) OR EXISTS (SELECT 1 FROM pedidos WHERE rrpp_id = ?)`, rrppId, rrppId, rrppId);
  if (usado) throw new HttpError(409, 'Tiene clientes o pedidos: pausalo en vez de borrarlo.');
  const { changes } = run('DELETE FROM rrpp WHERE id = ?', rrppId);
  if (!changes) throw new HttpError(404, 'RRPP no encontrado.');
  res.json({ ok: true });
});

// --- Listas de cada RRPP ---

function consultarLista(q) {
  const eventoId = id(q.evento_id);
  const rrppId = id(q.rrpp);
  const filtro = q.rrpp === 'sin' ? 'sin' : rrppId ? 'uno' : '';
  const filas = all(`
    SELECT l.id, l.creado_en, c.nombre, c.instagram, c.telefono, c.cumpleanos,
           COALESCE(r.nombre, 'Sin RRPP') AS rrpp_nombre, e.nombre AS evento_nombre, e.fecha AS evento_fecha,
           (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id AND p.evento_id = l.evento_id AND p.estado = 'pagado') AS pagados
    FROM lista_rrpp l
    JOIN clientes c ON c.id = l.cliente_id
    JOIN eventos e ON e.id = l.evento_id
    LEFT JOIN rrpp r ON r.id = l.rrpp_id
    WHERE (? = 0 OR l.evento_id = ?) AND (? = '' OR (? = 'sin' AND l.rrpp_id IS NULL) OR l.rrpp_id = ?)
    ORDER BY l.creado_en DESC`, eventoId, eventoId, filtro, filtro, rrppId);
  return filtrar(filas, q.q, ['nombre', 'instagram', 'telefono']);
}

admin.get('/listas', (req, res) => res.json({ lista: consultarLista(req.query) }));

// --- Clientes ---

function consultarClientes(q) {
  const mes = Number(q.mes);
  const conMes = Number.isInteger(mes) && mes >= 1 && mes <= 12 ? mes : 0;
  const filas = all(`
    SELECT c.*, COALESCE(r.nombre, 'Sin RRPP') AS rrpp_nombre, e.nombre AS evento_nombre
    FROM clientes c
    LEFT JOIN rrpp r ON r.id = c.rrpp_id
    LEFT JOIN eventos e ON e.id = c.evento_id
    WHERE (? = 0 OR CAST(substr(c.cumpleanos, 6, 2) AS INTEGER) = ?)
    ORDER BY ${conMes ? 'substr(c.cumpleanos, 9, 2), c.nombre' : 'c.creado_en DESC'}`, conMes, conMes);
  return filtrar(filas, q.q, ['nombre', 'instagram', 'telefono', 'rrpp_nombre']);
}

admin.get('/clientes', (req, res) => res.json({ clientes: consultarClientes(req.query) }));

// --- Exportar a CSV (Excel) ---

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita que Excel lo tome como fórmula
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Teléfono como texto: así Excel no le saca el "+" ni lo pasa a notación científica.
// Es seguro porque un teléfono validado solo tiene "+" y números.
const csvTelefono = (tel) => ({ crudo: `"=""${tel}"""` });

function enviarCsv(res, nombreArchivo, filas) {
  const celda = (valor) => (valor?.crudo !== undefined ? valor.crudo : csvCell(valor));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  res.send('﻿' + filas.map((fila) => fila.map(celda).join(',')).join('\n'));
}

const dma = (fecha) => (fecha ? fecha.slice(0, 10).split('-').reverse().join('/') : '');

admin.get('/clientes.csv', (req, res) => {
  const filas = [['Nombre', 'Instagram', 'Teléfono', 'Cumpleaños', 'RRPP', 'Se registró para', 'Fecha de registro']];
  for (const c of consultarClientes(req.query)) {
    filas.push([c.nombre, c.instagram, csvTelefono(c.telefono), dma(c.cumpleanos), c.rrpp_nombre, c.evento_nombre ?? '', c.creado_en.slice(0, 16).replace('T', ' ')]);
  }
  enviarCsv(res, 'clientes.csv', filas);
});

admin.get('/listas.csv', (req, res) => {
  const filas = [['Nombre', 'Instagram', 'Teléfono', 'Cumpleaños', 'RRPP', 'Fiesta', 'Anotado', 'Compró']];
  for (const l of consultarLista(req.query)) {
    filas.push([l.nombre, l.instagram, csvTelefono(l.telefono), dma(l.cumpleanos), l.rrpp_nombre, l.evento_nombre, l.creado_en.slice(0, 16).replace('T', ' '), l.pagados ? 'Sí' : 'No']);
  }
  enviarCsv(res, 'lista-rrpp.csv', filas);
});

// --- Fiestas ---

function eventoDesde(b, previo = {}) {
  const nombre = str(b.nombre ?? previo.nombre, 80);
  const fecha = str(b.fecha ?? previo.fecha, 16);
  if (!nombre) throw new HttpError(400, 'La fiesta necesita un nombre.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fecha)) throw new HttpError(400, 'Fecha y hora inválidas.');
  const cupo = Number(b.cupo ?? previo.cupo ?? 0);
  if (!Number.isInteger(cupo) || cupo < 0) throw new HttpError(400, 'El cupo tiene que ser un número entero (0 = sin límite).');
  return {
    nombre,
    fecha,
    descripcion: str(b.descripcion ?? previo.descripcion ?? '', 600),
    direccion: str(b.direccion ?? previo.direccion ?? '', 200),
    cupo,
    abierto: (b.abierto ?? previo.abierto ?? true) ? 1 : 0,
  };
}

admin.get('/eventos', (_req, res) => {
  const eventos = all(`
    SELECT e.*,
      (SELECT COUNT(*) FROM lista_rrpp l WHERE l.evento_id = e.id) AS registrados,
      (SELECT COUNT(*) FROM pedidos p WHERE p.evento_id = e.id) AS pedidos,
      (SELECT COALESCE(SUM(total), 0) FROM pedidos p WHERE p.evento_id = e.id AND p.estado = 'pagado') AS cobrado
    FROM eventos e ORDER BY e.fecha DESC`);
  res.json({ eventos });
});

admin.post('/eventos', (req, res) => {
  const e = eventoDesde(req.body);
  const { lastInsertRowid } = run(
    'INSERT INTO eventos (nombre, fecha, descripcion, direccion, cupo, abierto) VALUES (?, ?, ?, ?, ?, ?)',
    e.nombre, e.fecha, e.descripcion, e.direccion, e.cupo, e.abierto,
  );
  res.status(201).json({ evento: get('SELECT * FROM eventos WHERE id = ?', lastInsertRowid) });
});

admin.put('/eventos/:id', (req, res) => {
  const previo = get('SELECT * FROM eventos WHERE id = ?', id(req.params.id));
  if (!previo) throw new HttpError(404, 'Fiesta no encontrada.');
  const e = eventoDesde(req.body, previo);
  run('UPDATE eventos SET nombre = ?, fecha = ?, descripcion = ?, direccion = ?, cupo = ?, abierto = ? WHERE id = ?',
    e.nombre, e.fecha, e.descripcion, e.direccion, e.cupo, e.abierto, previo.id);
  res.json({ evento: get('SELECT * FROM eventos WHERE id = ?', previo.id) });
});

admin.delete('/eventos/:id', (req, res) => {
  const eventoId = id(req.params.id);
  if (get('SELECT 1 FROM pedidos WHERE evento_id = ?', eventoId)) {
    throw new HttpError(409, 'Tiene pedidos: cerrala en vez de borrarla.');
  }
  const { changes } = run('DELETE FROM eventos WHERE id = ?', eventoId);
  if (!changes) throw new HttpError(404, 'Fiesta no encontrada.');
  res.json({ ok: true });
});

// --- Ajustes ---

function vistaConfig() {
  const c = config();
  return Object.fromEntries(CLAVES_CONFIG.map((clave) => [clave, c[clave]]));
}

admin.get('/configuracion', (_req, res) => {
  res.json({ configuracion: vistaConfig(), mercadoPagoConfigurado: Boolean(MP_TOKEN) });
});

admin.put('/configuracion', (req, res) => {
  const b = req.body;
  const cambios = {};
  const texto = (clave, max) => {
    if (b[clave] !== undefined) cambios[clave] = str(b[clave], max);
  };

  if (b.nombre_lugar !== undefined) {
    cambios.nombre_lugar = str(b.nombre_lugar, 40);
    if (!cambios.nombre_lugar) throw new HttpError(400, 'Falta el nombre del lugar.');
  }
  texto('texto_puerta_1', 140);
  texto('texto_puerta_2', 140);
  texto('texto_pie', 140);
  if (b.instagram !== undefined) {
    const ig = str(b.instagram, 60) ? Validar.instagram(b.instagram) : { valor: '', error: null };
    if (ig.error) throw new HttpError(400, `Instagram: ${ig.error}`);
    cambios.instagram = ig.valor;
  }
  if (b.whatsapp !== undefined) {
    const tel = str(b.whatsapp, 30) ? Validar.telefono(b.whatsapp) : { valor: '', error: null };
    if (tel.error) throw new HttpError(400, `WhatsApp: ${tel.error}`);
    cambios.whatsapp = tel.valor;
  }
  if (b.edad_minima !== undefined) {
    const edad = Number(b.edad_minima);
    if (!Number.isInteger(edad) || edad < 0 || edad > 99) throw new HttpError(400, 'La edad mínima tiene que ser un número entre 0 y 99.');
    cambios.edad_minima = edad;
  }
  if (b.permitir_sin_rrpp !== undefined) cambios.permitir_sin_rrpp = Boolean(b.permitir_sin_rrpp);
  if (b.recargo !== undefined) {
    const recargo = Validar.pesos(b.recargo);
    if (Number.isNaN(recargo) || recargo > 1_000_000) throw new HttpError(400, 'El recargo tiene que ser un monto en pesos, sin centavos.');
    cambios.recargo = recargo;
  }
  if (b.metodo_pago !== undefined) {
    if (!METODOS_PAGO.includes(b.metodo_pago)) throw new HttpError(400, 'Método de pago inválido.');
    cambios.metodo_pago = b.metodo_pago;
  }
  if (b.transferencia_alias !== undefined) {
    cambios.transferencia_alias = str(b.transferencia_alias, 20);
    if (cambios.transferencia_alias && !/^[a-zA-Z0-9.-]{6,20}$/.test(cambios.transferencia_alias)) {
      throw new HttpError(400, 'El alias tiene que tener entre 6 y 20 letras, números, puntos o guiones.');
    }
  }
  if (b.transferencia_cbu !== undefined) {
    cambios.transferencia_cbu = str(b.transferencia_cbu, 30).replace(/\s/g, '');
    if (cambios.transferencia_cbu && !/^\d{22}$/.test(cambios.transferencia_cbu)) {
      throw new HttpError(400, 'El CBU/CVU tiene que tener 22 números.');
    }
  }
  texto('transferencia_titular', 80);
  if (b.consentimiento !== undefined) {
    cambios.consentimiento = str(b.consentimiento, 3000);
    if (cambios.consentimiento.length < 40) throw new HttpError(400, 'El texto sobre el uso de datos es obligatorio.');
  }
  guardarConfig(cambios);
  res.json({ configuracion: vistaConfig(), mercadoPagoConfigurado: Boolean(MP_TOKEN) });
});

app.use('/api/admin', admin);
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Errores ----------

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada.')));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  let mensaje = err.message;
  if (err.type === 'entity.parse.failed') mensaje = 'Datos inválidos.';
  if (err.type === 'entity.too.large') mensaje = 'Demasiados datos.';
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : mensaje, ...(err.extra || {}) });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Funcionando en http://localhost:${PORT}`));
}

module.exports = app;
