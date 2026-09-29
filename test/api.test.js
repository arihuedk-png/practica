const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'productora-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'clave-del-panel';
process.env.INITIAL_CODE = 'luna llena';
process.env.MP_ACCESS_TOKEN = 'TEST-token';
process.env.PUBLIC_URL = 'https://productora.example';

// Mercado Pago simulado: el servidor habla con su API usando fetch.
const fetchReal = globalThis.fetch;
const mp = { preferencias: [], pagos: new Map() };
globalThis.fetch = async (url, opciones = {}) => {
  const u = String(url);
  if (u === 'https://api.mercadopago.com/checkout/preferences') {
    const body = JSON.parse(opciones.body);
    mp.preferencias.push({ body, auth: opciones.headers.Authorization });
    return Response.json({ id: 'pref', init_point: `https://mp.example/pagar/${body.external_reference}` });
  }
  const pago = u.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(.+)$/);
  if (pago) {
    const datos = mp.pagos.get(decodeURIComponent(pago[1]));
    return datos ? Response.json(datos) : new Response('no existe', { status: 404 });
  }
  return fetchReal(url, opciones);
};

const app = require('../server');
let server;
let base;
let admin;

// Un "navegador" con sus propias cookies y su propia IP.
function navegador(ip) {
  const cookies = new Map();
  return async function llamar(url, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip,
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [par] = cookie.split(';');
      const [clave, ...valor] = par.split('=');
      if (/Max-Age=0/.test(cookie)) cookies.delete(clave);
      else cookies.set(clave, valor.join('='));
    }
    const texto = await res.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch { /* no es JSON */ }
    return { status: res.status, body: json, texto, cookies };
  };
}

const datos = (cambios = {}) => ({
  evento_id: 1,
  nombre: 'Sofía Pérez',
  instagram: '@sofi.perez',
  cumpleanos: '1998-05-10',
  telefono: '+54 9 11 1234-5678',
  consentimiento: true,
  ...cambios,
});

async function clienteRegistrado(ip, codigo, cambios) {
  const cliente = navegador(ip);
  assert.equal((await cliente('/api/acceso', { method: 'POST', body: { codigo } })).status, 200);
  const registro = await cliente('/api/registro', { method: 'POST', body: datos(cambios) });
  assert.equal(registro.status, 201, JSON.stringify(registro.body));
  return cliente;
}

async function esperar(condicion) {
  for (let i = 0; i < 50; i++) {
    if (await condicion()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('No se cumplió la condición a tiempo');
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = navegador('10.9.9.9');
  assert.equal((await admin('/api/admin/login', { method: 'POST', body: { password: 'clave-del-panel' } })).status, 200);
});

after(() => {
  server.close();
  globalThis.fetch = fetchReal;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sin código no se ve nada: ni registro, ni precios, ni compras', async () => {
  const visitante = navegador('10.0.0.1');
  const sesion = await visitante('/api/sesion');
  assert.deepEqual(sesion.body, { acceso: false, cliente: null, eventos: [], anotado: [] });
  assert.equal((await visitante('/api/registro', { method: 'POST', body: datos() })).body.motivo, 'acceso');
  assert.equal((await visitante('/api/catalogo?evento_id=1')).status, 401);
  assert.equal((await visitante('/api/pedidos', { method: 'POST', body: {} })).status, 401);
  assert.equal((await visitante('/api/acceso/sin-rrpp', { method: 'POST', body: {} })).status, 403);
  const config = await visitante('/api/config');
  assert.ok(!config.texto.includes('LUNA'), 'el código nunca se manda al navegador');
  assert.match(config.body.consentimiento, /medianoche/);
});

test('código incorrecto: error y límite de intentos', async () => {
  const visitante = navegador('10.0.0.2');
  const mal = await visitante('/api/acceso', { method: 'POST', body: { codigo: 'nope' } });
  assert.equal(mal.status, 401);
  assert.match(mal.body.error, /No es ese/);
  let ultimo;
  for (let i = 0; i < 8; i++) ultimo = await visitante('/api/acceso', { method: 'POST', body: { codigo: 'nope' } });
  assert.equal(ultimo.status, 429);
});

test('registro obligatorio: valida cada campo y guarda el cliente con su RRPP y fecha', async () => {
  const cliente = navegador('10.0.0.3');
  assert.equal((await cliente('/api/acceso', { method: 'POST', body: { codigo: ' Luna Llena ' } })).status, 200);

  const vacio = await cliente('/api/registro', {
    method: 'POST',
    body: { evento_id: 1, nombre: '', instagram: '', cumpleanos: '', telefono: '', consentimiento: false },
  });
  assert.equal(vacio.status, 400);
  assert.deepEqual(Object.keys(vacio.body.campos).sort(), ['consentimiento', 'cumpleanos', 'instagram', 'nombre', 'telefono']);

  const casos = [
    [{ nombre: 'Sofía' }, 'nombre'],
    [{ instagram: 'sofi perez' }, 'instagram'],
    [{ cumpleanos: '2015-01-01' }, 'cumpleanos'],
    [{ telefono: '11 1234 5678' }, 'telefono'],
    [{ telefono: '+54 011 1234 5678' }, 'telefono'],
    [{ consentimiento: 'si' }, 'consentimiento'],
  ];
  for (const [cambio, campo] of casos) {
    const r = await cliente('/api/registro', { method: 'POST', body: datos(cambio) });
    assert.equal(r.status, 400, JSON.stringify(cambio));
    assert.deepEqual(Object.keys(r.body.campos), [campo]);
  }

  const ok = await cliente('/api/registro', { method: 'POST', body: datos() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.reutilizado, false);
  const sesion = await cliente('/api/sesion');
  assert.deepEqual(sesion.body.anotado, [1]);
  assert.equal(sesion.body.cliente.nombre, 'Sofía Pérez');

  const { clientes } = (await admin('/api/admin/clientes')).body;
  assert.equal(clientes.length, 1);
  assert.equal(clientes[0].telefono, '+5491112345678');
  assert.equal(clientes[0].instagram, 'sofi.perez');
  assert.equal(clientes[0].rrpp_nombre, 'General');
  assert.equal(clientes[0].evento_nombre, 'Noche de apertura');
  assert.ok(clientes[0].consentimiento_en);
  assert.equal((await admin('/api/admin/listas?evento_id=1')).body.lista.length, 1);
});

test('teléfono repetido: reutiliza el cliente solo si coincide el cumpleaños', async () => {
  const otro = navegador('10.0.0.4');
  await otro('/api/acceso', { method: 'POST', body: { codigo: 'lunallena' } });
  const mismoTelefono = await otro('/api/registro', { method: 'POST', body: datos({ telefono: '+54 11 1234 5678', nombre: 'Sofi Perez' }) });
  assert.equal(mismoTelefono.status, 201);
  assert.equal(mismoTelefono.body.reutilizado, true);
  assert.equal(mismoTelefono.body.cliente.nombre, 'Sofía Pérez', 'se reutiliza sin pisar los datos guardados');

  const impostor = navegador('10.0.0.5');
  await impostor('/api/acceso', { method: 'POST', body: { codigo: 'lunallena' } });
  const r = await impostor('/api/registro', { method: 'POST', body: datos({ cumpleanos: '1990-01-01' }) });
  assert.equal(r.status, 409);
  assert.ok(r.body.campos.cumpleanos);
  assert.equal((await admin('/api/admin/clientes')).body.clientes.length, 1, 'no se duplicó');
});

let vip;
let botella;

test('catálogo: precio + recargo = total, y el pedido queda pendiente de aprobación', async () => {
  const { productos } = (await admin('/api/admin/productos')).body;
  assert.deepEqual(productos.map((p) => [p.nombre, p.activo]), [['Entrada VIP', 0], ['Cabina', 0], ['Combo botella', 0]]);
  vip = (await admin(`/api/admin/productos/${productos[0].id}`, { method: 'PUT', body: { precio: '15.000', activo: true } })).body.producto;
  botella = (await admin(`/api/admin/productos/${productos[2].id}`, { method: 'PUT', body: { precio: 80000, activo: true } })).body.producto;
  assert.equal(vip.precio, 15000);
  assert.equal((await admin(`/api/admin/productos/${vip.id}`, { method: 'PUT', body: { precio: '15,50' } })).status, 400);

  const cliente = await clienteRegistrado('10.0.0.6', 'lunallena', { telefono: '+5491122223333', nombre: 'Juan Gómez', instagram: 'juang' });
  const catalogo = (await cliente('/api/catalogo?evento_id=1')).body;
  assert.equal(catalogo.recargo, 1000);
  assert.deepEqual(catalogo.productos.map((p) => [p.nombre, p.precio, p.recargo, p.total]), [
    ['Entrada VIP', 15000, 1000, 16000],
    ['Combo botella', 80000, 1000, 81000],
  ]);

  const pedido = await cliente('/api/pedidos', {
    method: 'POST',
    body: { evento_id: 1, items: [{ producto_id: vip.id, cantidad: 2 }, { producto_id: botella.id, cantidad: 1 }] },
  });
  assert.equal(pedido.status, 201);
  assert.equal(pedido.body.pedido.estado, 'pendiente');
  assert.equal(pedido.body.pedido.total, 16000 * 2 + 81000);
  assert.equal(pedido.body.pedido.pago, null, 'no se paga hasta que el dueño apruebe');
  assert.equal(pedido.body.pedido.evento.direccion, null);
  assert.deepEqual(pedido.body.pedido.items.map((i) => [i.nombre, i.precio, i.recargo, i.cantidad, i.subtotal]), [
    ['Entrada VIP', 15000, 1000, 2, 32000],
    ['Combo botella', 80000, 1000, 1, 81000],
  ]);

  const cabina = productos[1].id;
  assert.equal((await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [{ producto_id: cabina, cantidad: 1 }] } })).status, 400);
  assert.equal((await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [{ producto_id: vip.id, cantidad: 11 }] } })).status, 400);
  assert.equal((await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [] } })).status, 400);

  const { id, token } = pedido.body.pedido;
  assert.equal((await navegador('10.0.0.7')(`/api/pedidos/${id}?t=${token}`)).status, 200);
  assert.equal((await navegador('10.0.0.7')(`/api/pedidos/${id}?t=otro`)).status, 404);
});

test('el dueño aprueba y se habilita el pago por transferencia; después marca pagado e ingreso', async () => {
  const guardado = await admin('/api/admin/configuracion', {
    method: 'PUT',
    body: { metodo_pago: 'transferencia', transferencia_alias: 'medianoche.mp', transferencia_titular: 'Medianoche SRL', whatsapp: '+54 9 11 5555 0000' },
  });
  assert.equal(guardado.status, 200);
  assert.equal(guardado.body.configuracion.whatsapp, '+5491155550000');
  assert.equal((await admin('/api/admin/configuracion', { method: 'PUT', body: { transferencia_cbu: '123' } })).status, 400);

  const cliente = await clienteRegistrado('10.0.0.8', 'lunallena', { telefono: '+5491144445555', nombre: 'Lara Díaz', instagram: 'larad' });
  const { pedido } = (await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [{ producto_id: vip.id, cantidad: 1 }] } })).body;
  const ver = async () => (await cliente(`/api/pedidos/${pedido.id}?t=${pedido.token}`)).body.pedido;

  const pendientes = (await admin('/api/admin/pedidos?estado=pendiente')).body;
  assert.ok(pendientes.pedidos.some((p) => p.id === pedido.id && p.cliente_nombre === 'Lara Díaz' && p.rrpp_nombre === 'General'));
  assert.equal(pendientes.resumen.pendientes, 2);

  assert.equal((await admin(`/api/admin/pedidos/${pedido.id}/pagado`, { method: 'POST', body: {} })).status, 409, 'no se cobra lo no aprobado');
  assert.equal((await admin(`/api/admin/pedidos/${pedido.id}/aprobar`, { method: 'POST', body: {} })).body.pedido.estado, 'aprobado');
  assert.equal((await admin(`/api/admin/pedidos/${pedido.id}/aprobar`, { method: 'POST', body: {} })).status, 409);

  let vista = await ver();
  assert.equal(vista.estado, 'aprobado');
  assert.deepEqual(vista.pago, { mercadopago: null, transferencia: { alias: 'medianoche.mp', cbu: '', titular: 'Medianoche SRL' } });
  assert.equal(vista.whatsapp, '+5491155550000');
  assert.equal(vista.evento.direccion, null);

  await admin(`/api/admin/pedidos/${pedido.id}/pagado`, { method: 'POST', body: {} });
  vista = await ver();
  assert.equal(vista.estado, 'pagado');
  assert.equal(vista.pago, null);
  assert.equal(vista.evento.direccion, 'Dirección a confirmar', 'la dirección aparece al pagar');

  assert.ok((await admin(`/api/admin/pedidos/${pedido.id}/ingreso`, { method: 'POST', body: {} })).body.pedido.ingreso_en);
  assert.equal((await admin(`/api/admin/pedidos/${pedido.id}/ingreso`, { method: 'POST', body: { deshacer: true } })).body.pedido.ingreso_en, null);

  const rechazo = (await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [{ producto_id: botella.id, cantidad: 3 }] } })).body.pedido;
  assert.equal((await admin(`/api/admin/pedidos/${rechazo.id}/rechazar`, { method: 'POST', body: {} })).body.pedido.estado, 'rechazado');
  assert.equal((await cliente(`/api/pedidos/${rechazo.id}?t=${rechazo.token}`)).body.pedido.estado, 'rechazado');
  assert.equal((await admin(`/api/admin/pedidos/${rechazo.id}/pendiente`, { method: 'POST', body: {} })).body.pedido.estado, 'pendiente');

  const busqueda = (await admin(`/api/admin/pedidos?q=${pedido.codigo.toLowerCase()}`)).body.pedidos;
  assert.deepEqual(busqueda.map((p) => p.id), [pedido.id]);
  assert.equal((await admin('/api/admin/pedidos?q=lara diaz')).body.pedidos.length, 2, 'busca sin tildes');
});

test('el recargo se cambia desde el panel y cada pedido guarda el que tenía', async () => {
  assert.equal((await admin('/api/admin/configuracion', { method: 'PUT', body: { recargo: 'mil' } })).status, 400);
  assert.equal((await admin('/api/admin/configuracion', { method: 'PUT', body: { recargo: '2.500' } })).body.configuracion.recargo, 2500);

  const cliente = await clienteRegistrado('10.0.0.10', 'lunallena', { telefono: '+5491166667777', nombre: 'Tomás Ruiz', instagram: 'tomi.r' });
  const vipCatalogo = (await cliente('/api/catalogo?evento_id=1')).body.productos.find((p) => p.id === vip.id);
  assert.deepEqual([vipCatalogo.precio, vipCatalogo.recargo, vipCatalogo.total], [15000, 2500, 17500]);

  const viejos = (await admin('/api/admin/pedidos')).body.pedidos.filter((p) => p.cliente_nombre === 'Juan Gómez');
  assert.ok(viejos.every((p) => p.items.every((i) => i.recargo === 1000)));
  await admin('/api/admin/configuracion', { method: 'PUT', body: { recargo: 1000 } });
});

test('Mercado Pago: al aprobar se crea el link y el aviso de pago lo marca pagado', async () => {
  await admin('/api/admin/configuracion', { method: 'PUT', body: { metodo_pago: 'mercadopago' } });
  const cliente = await clienteRegistrado('10.0.0.11', 'lunallena', { telefono: '+5491177778888', nombre: 'Martina Sosa', instagram: 'martu' });
  const nuevo = async () => (await cliente('/api/pedidos', { method: 'POST', body: { evento_id: 1, items: [{ producto_id: vip.id, cantidad: 2 }] } })).body.pedido;
  const pedido = await nuevo();
  const ver = async (p) => (await cliente(`/api/pedidos/${p.id}?t=${p.token}`)).body.pedido;

  assert.equal((await ver(pedido)).pago, null);
  assert.equal(mp.preferencias.length, 0, 'no hay link antes de aprobar');
  await admin(`/api/admin/pedidos/${pedido.id}/aprobar`, { method: 'POST', body: {} });

  const vista = await ver(pedido);
  assert.equal(vista.pago.mercadopago, `https://mp.example/pagar/${pedido.id}`);
  assert.equal(vista.pago.transferencia, null);
  const [preferencia] = mp.preferencias;
  assert.equal(preferencia.auth, 'Bearer TEST-token');
  assert.deepEqual(preferencia.body.items, [{ title: 'Entrada VIP', quantity: 2, unit_price: 16000, currency_id: 'ARS' }]);
  assert.equal(preferencia.body.notification_url, 'https://productora.example/api/pagos/webhook');
  assert.equal(preferencia.body.back_urls.success, `https://productora.example/?pedido=${pedido.id}&t=${pedido.token}`);
  await ver(pedido);
  assert.equal(mp.preferencias.length, 1, 'el link se crea una sola vez');

  // Un aviso falso (pago que no existe en Mercado Pago) no cambia nada.
  const aviso = (pagoId) => navegador('10.0.0.12')('/api/pagos/webhook', { method: 'POST', body: { type: 'payment', data: { id: pagoId } } });
  assert.equal((await aviso('no-existe')).status, 200);

  // Un pago por menos plata tampoco.
  const otro = await nuevo();
  await admin(`/api/admin/pedidos/${otro.id}/aprobar`, { method: 'POST', body: {} });
  mp.pagos.set('111', { id: 111, status: 'approved', external_reference: String(otro.id), transaction_amount: 100, currency_id: 'ARS' });
  await aviso('111');

  mp.pagos.set('222', { id: 222, status: 'approved', external_reference: String(pedido.id), transaction_amount: 32000, currency_id: 'ARS' });
  await aviso('222');
  await esperar(async () => (await ver(pedido)).estado === 'pagado');
  assert.equal((await ver(otro)).estado, 'aprobado');
  await admin('/api/admin/configuracion', { method: 'PUT', body: { metodo_pago: 'transferencia' } });
});

test('entrar sin RRPP solo si el dueño lo habilita', async () => {
  const visitante = navegador('10.0.0.13');
  assert.equal((await visitante('/api/acceso/sin-rrpp', { method: 'POST', body: {} })).status, 403);
  await admin('/api/admin/configuracion', { method: 'PUT', body: { permitir_sin_rrpp: true } });
  assert.equal((await visitante('/api/config')).body.permitir_sin_rrpp, true);
  assert.equal((await visitante('/api/acceso/sin-rrpp', { method: 'POST', body: {} })).status, 200);
  assert.equal((await visitante('/api/registro', { method: 'POST', body: datos({ telefono: '+5491199990000', nombre: 'Nico Paz', instagram: 'nicopaz' }) })).status, 201);

  const sinRrpp = (await admin('/api/admin/listas?rrpp=sin')).body.lista;
  assert.deepEqual(sinRrpp.map((l) => [l.nombre, l.rrpp_nombre]), [['Nico Paz', 'Sin RRPP']]);

  await admin('/api/admin/configuracion', { method: 'PUT', body: { permitir_sin_rrpp: false } });
  assert.equal((await visitante('/api/sesion')).body.acceso, false, 'al deshabilitarlo se corta el acceso');
});

test('panel: RRPP con código único, su lista por fecha, clientes, cumpleaños y CSV', async () => {
  const creado = await admin('/api/admin/rrpp', { method: 'POST', body: { nombre: 'Juli', codigo: 'juli vip' } });
  assert.equal(creado.status, 201);
  assert.equal(creado.body.rrpp.codigo, 'JULIVIP');
  assert.equal((await admin('/api/admin/rrpp', { method: 'POST', body: { nombre: 'Otra', codigo: 'JULIVIP' } })).status, 409);
  assert.equal((await admin('/api/admin/rrpp', { method: 'POST', body: { nombre: 'Otra', codigo: 'x' } })).status, 400);
  const juli = creado.body.rrpp;

  const invitado = await clienteRegistrado('10.0.0.14', 'julivip', { telefono: '+5491133334444', nombre: 'Carla Vega', instagram: 'carlav', cumpleanos: '2000-06-15' });
  const otraFecha = (await admin('/api/admin/eventos', { method: 'POST', body: { nombre: 'Segunda fecha', fecha: '2026-12-12T23:30' } })).body.evento;

  assert.deepEqual((await admin(`/api/admin/listas?rrpp=${juli.id}`)).body.lista.map((l) => l.nombre), ['Carla Vega']);
  assert.equal((await admin(`/api/admin/listas?rrpp=${juli.id}&evento_id=${otraFecha.id}`)).body.lista.length, 0);
  const estadisticas = (await admin('/api/admin/rrpp')).body.rrpp.find((r) => r.id === juli.id);
  assert.equal(estadisticas.anotados, 1);

  // Si vuelve con otro código para la misma fecha, sigue en la lista del primer RRPP.
  await invitado('/api/acceso', { method: 'POST', body: { codigo: 'lunallena' } });
  assert.equal((await invitado('/api/lista', { method: 'POST', body: { evento_id: 1 } })).status, 200);
  assert.equal((await admin(`/api/admin/listas?rrpp=${juli.id}`)).body.lista.length, 1);

  assert.equal((await admin(`/api/admin/rrpp/${juli.id}`, { method: 'DELETE' })).status, 409, 'un RRPP con clientes no se borra');
  await admin(`/api/admin/rrpp/${juli.id}`, { method: 'PUT', body: { activo: false } });
  const conJuli = navegador('10.0.0.15');
  assert.equal((await conJuli('/api/acceso', { method: 'POST', body: { codigo: 'julivip' } })).status, 401, 'un RRPP pausado no deja entrar');

  const mayo = (await admin('/api/admin/clientes?mes=5')).body.clientes.map((c) => c.nombre);
  assert.ok(mayo.includes('Sofía Pérez'));
  assert.ok(!mayo.includes('Carla Vega'));
  assert.deepEqual((await admin('/api/admin/clientes?mes=6')).body.clientes.map((c) => c.nombre), ['Carla Vega']);
  assert.deepEqual((await admin('/api/admin/clientes?q=vega')).body.clientes.map((c) => c.rrpp_nombre), ['Juli']);

  const csv = await admin('/api/admin/clientes.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.texto, /^Nombre,Instagram,Teléfono,Cumpleaños,RRPP/);
  const crudo = await fetch(`${base}/api/admin/clientes.csv`, { headers: { Cookie: `admin=${csv.cookies.get('admin')}` } });
  assert.deepEqual([...new Uint8Array(await crudo.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf], 'con BOM para que Excel lea las tildes');
  assert.match(csv.texto, /Carla Vega,carlav,"=""\+5491133334444""",15\/06\/2000,Juli/);
  assert.match((await admin(`/api/admin/listas.csv?rrpp=${juli.id}`)).texto, /Carla Vega/);

  assert.equal((await admin('/api/admin/eventos/1', { method: 'DELETE' })).status, 409, 'una fecha con pedidos no se borra');
  assert.equal((await admin(`/api/admin/eventos/${otraFecha.id}`, { method: 'DELETE' })).status, 200);
});

test('seguridad: panel con contraseña, solo JSON y cookies firmadas', async () => {
  const intruso = navegador('10.0.0.16');
  for (const ruta of ['/api/admin/pedidos', '/api/admin/clientes', '/api/admin/clientes.csv', '/api/admin/configuracion']) {
    assert.equal((await intruso(ruta)).status, 401, ruta);
  }
  assert.equal((await intruso('/api/admin/login', { method: 'POST', body: { password: 'nop' } })).status, 401);
  const formulario = await intruso('/api/acceso', { method: 'POST', body: { codigo: 'lunallena' }, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(formulario.status, 415);
  const trucho = await intruso('/api/sesion', { headers: { Cookie: 'acceso=eyJycnBwSWQiOjF9.firma; cliente=eyJjbGllbnRlSWQiOjF9.firma' } });
  assert.deepEqual([trucho.body.acceso, trucho.body.cliente], [false, null]);
  const config = (await admin('/api/admin/configuracion')).body;
  assert.equal(config.configuracion.secreto_sesion, undefined, 'el secreto nunca sale de la base');
  assert.equal(config.mercadoPagoConfigurado, true);
});
