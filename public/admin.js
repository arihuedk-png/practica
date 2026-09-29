const panel = {
  lugar: '',
  tab: 'pedidos',
  eventos: [],
  rrpp: [],
  productos: [],
  recargo: 0,
  editandoProducto: null,
  editandoRrpp: null,
  editandoEvento: null,
  pendientesVistos: null,
};
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ESTADO_TEXTO = { pendiente: 'Pendiente', aprobado: 'Aprobado · falta pagar', rechazado: 'Rechazado', pagado: 'Pagado' };

function toast(texto) {
  $$('.toast').forEach((viejo) => viejo.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = texto;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// Botón que pide un segundo toque para confirmar (sin ventanas emergentes).
function confirmado(boton) {
  if (boton.dataset.armado) return true;
  boton.dataset.armado = '1';
  const original = boton.textContent;
  boton.textContent = '¿Seguro?';
  setTimeout(() => { delete boton.dataset.armado; boton.textContent = original; }, 3000);
  return false;
}

const hoy = () => new Date().toISOString().slice(0, 10);
const dm = (fecha) => `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;
const fechaHora = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fechaCorta = (iso) => new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const waLink = (tel, texto) => `https://wa.me/${tel.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;
const vacio = (texto) => `<p class="empty">${texto}</p>`;
const primerNombre = (nombre) => nombre.split(' ')[0];

// Botón para escribirle a una persona por WhatsApp, con un saludo ya escrito (se puede cambiar antes de mandar).
function botonWhatsApp(telefono, mensaje) {
  return `<a class="btn btn-ghost small" href="${waLink(telefono, mensaje)}" target="_blank" rel="noopener">WhatsApp</a>`;
}

// ---------- Sesión ----------

async function start() {
  try {
    const config = await api('/api/config');
    $$('[data-club-name]').forEach((el) => { el.textContent = config.nombre_lugar; });
    panel.lugar = config.nombre_lugar;
  } catch { /* sigue igual */ }
  try {
    await api('/api/admin/me');
  } catch {
    $('#loginView').hidden = false;
    $('#panelView').hidden = true;
    fitLogos();
    setTimeout(() => $('#password').focus(), 50);
    return;
  }
  $('#loginView').hidden = true;
  $('#panelView').hidden = false;
  fitLogos();
  await Promise.all([cargarEventos(), cargarRrpp()]);
  showTab(panel.tab);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginMessage').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    start();
  } catch (err) {
    $('#loginMessage').textContent = err.message;
  }
});

$('#logoutBtn').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' });
  location.reload();
};

function showTab(tab) {
  panel.tab = tab;
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  const cargar = {
    pedidos: cargarPedidos,
    productos: cargarProductos,
    rrpp: cargarRrpp,
    listas: cargarListas,
    clientes: cargarClientes,
    eventos: cargarEventos,
    ajustes: cargarAjustes,
  }[tab];
  cargar().catch((err) => toast(err.message));
}

$$('[data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

// Selectores de fiesta y de RRPP que se usan en varias pestañas.
function llenarSelect(select, opciones, porDefecto) {
  const actual = select.value;
  select.innerHTML = opciones.map(([valor, texto]) => `<option value="${esc(valor)}">${esc(texto)}</option>`).join('');
  select.value = opciones.some(([valor]) => String(valor) === actual) ? actual : porDefecto;
}

function llenarSelects() {
  const fechas = panel.eventos.map((ev) => [ev.id, `${ev.nombre} · ${fmtEventDate(ev.fecha)}`]);
  llenarSelect($('#pedidosEvento'), [['', 'Todas las fechas'], ...fechas], '');
  llenarSelect($('#listasEvento'), [['', 'Todas las fechas'], ...fechas], '');
  llenarSelect($('#listasRrpp'), [['', 'Todos los RRPP'], ['sin', 'Sin RRPP'], ...panel.rrpp.map((r) => [r.id, r.nombre])], '');
  llenarSelect($('#clientesMes'), [['', 'Cumpleaños: todos los meses'], ...MESES.map((mes, i) => [i + 1, `Cumplen en ${mes}`])], '');
}

// ---------- Pedidos ----------

function mensajeWhatsApp(p, link) {
  const nombre = p.cliente_nombre.split(' ')[0];
  return {
    pendiente: `Hola ${nombre}! Recibimos tu pedido ${p.codigo} para ${p.evento_nombre}. Lo estamos revisando; podés ver cómo va acá: ${link}`,
    aprobado: `Hola ${nombre}! Tu pedido ${p.codigo} para ${p.evento_nombre} fue aprobado. Para confirmarlo, pagalo desde acá: ${link}`,
    rechazado: `Hola ${nombre}. Tu pedido ${p.codigo} para ${p.evento_nombre} no pudo ser aprobado. Cualquier duda, respondé este mensaje.`,
    pagado: `Hola ${nombre}! Tu pago del pedido ${p.codigo} está confirmado. Mostrá el código ${p.codigo} y tu DNI en la puerta. Detalle: ${link}`,
  }[p.estado];
}

function pedidoHtml(p) {
  const link = `${location.origin}/?pedido=${p.id}&t=${p.token}`;
  const boton = (accion, texto, extra = '') => `<button class="btn small ${extra}" data-accion="${accion}" data-id="${p.id}">${texto}</button>`;
  const acciones = {
    pendiente: boton('aprobar', 'Aprobar') + boton('rechazar', 'Rechazar', 'btn-ghost danger'),
    aprobado: boton('pagado', 'Marcar pagado') + boton('pendiente', 'Deshacer', 'btn-ghost'),
    rechazado: boton('pendiente', 'Volver a pendiente', 'btn-ghost'),
    pagado: p.ingreso_en ? boton('deshacer-ingreso', 'Deshacer ingreso', 'btn-ghost') : boton('ingreso', 'Marcar ingreso'),
  }[p.estado];
  const items = p.items.map((i) => `
    <li>
      <span>${i.cantidad} × ${esc(i.nombre)}</span>
      <span class="mono">${fmtPesos(i.subtotal)}</span>
      <small>(${fmtPesos(i.precio)} + ${fmtPesos(i.recargo)} recargo)${i.cantidad > 1 ? ` × ${i.cantidad}` : ''}</small>
    </li>`).join('');
  return `
    <div class="item pedido estado-${p.estado} ${p.ingreso_en ? 'in' : ''}">
      <div class="item-main">
        <p class="item-title">${esc(p.cliente_nombre)}
          <span class="chip estado-${p.estado}">${ESTADO_TEXTO[p.estado]}</span>
          ${p.ingreso_en ? '<span class="chip on">Entró</span>' : ''}</p>
        <p class="item-sub"><a href="https://instagram.com/${esc(p.instagram)}" target="_blank" rel="noopener">@${esc(p.instagram)}</a>
          · ${esc(p.telefono)} · RRPP: ${esc(p.rrpp_nombre || 'Sin RRPP')}</p>
        <p class="item-sub"><span class="mono">${esc(p.codigo)}</span> · ${esc(p.evento_nombre)} · ${fechaHora(p.creado_en)}</p>
        <ul class="lines">${items}</ul>
        <p class="lines-total"><span>Total</span><span class="mono">${fmtPesos(p.total)}</span></p>
        ${p.estado === 'aprobado' && p.mp_link ? '<p class="hint">El cliente ya tiene su link de Mercado Pago.</p>' : ''}
      </div>
      <div class="item-actions">
        ${acciones}
        <a class="btn btn-ghost small" href="${waLink(p.telefono, mensajeWhatsApp(p, link))}" target="_blank" rel="noopener">Avisar por WhatsApp</a>
      </div>
    </div>`;
}

async function cargarPedidos({ silencioso = false } = {}) {
  const params = new URLSearchParams({
    estado: $('#pedidosEstado').value,
    evento_id: $('#pedidosEvento').value,
    q: $('#pedidosBuscar').value.trim(),
  });
  const { pedidos, resumen } = await api(`/api/admin/pedidos?${params}`);
  $('#pedidosResumen').innerHTML = `
    <div class="stat"><b>${resumen.pendientes}</b><span>Pendientes</span></div>
    <div class="stat"><b>${fmtPesos(resumen.por_cobrar)}</b><span>Por cobrar</span></div>
    <div class="stat"><b>${fmtPesos(resumen.cobrado)}</b><span>Cobrado</span></div>`;
  $('#tabPendientes').hidden = !resumen.pendientes;
  $('#tabPendientes').textContent = resumen.pendientes;
  if (silencioso && panel.pendientesVistos !== null && resumen.pendientes > panel.pendientesVistos) {
    toast('Entró un pedido nuevo');
  }
  panel.pendientesVistos = resumen.pendientes;
  if (!silencioso) avisarSiFaltaCobro().catch(() => {});
  const sinResultados = {
    'por-resolver': 'Nada por resolver: no hay pedidos para aprobar ni pagos para confirmar.',
    pendiente: 'No hay pedidos esperando aprobación.',
  }[$('#pedidosEstado').value] || 'No hay pedidos con ese filtro.';
  $('#pedidosLista').innerHTML = pedidos.length ? pedidos.map(pedidoHtml).join('') : vacio(sinResultados);
}

// Si se aprueba un pedido sin haber cargado cómo cobrar, el cliente no tendría cómo pagar.
async function avisarSiFaltaCobro() {
  const { configuracion: c, mercadoPagoConfigurado } = await api('/api/admin/configuracion');
  const conMercadoPago = mercadoPagoConfigurado && c.metodo_pago !== 'transferencia';
  const conTransferencia = c.metodo_pago !== 'mercadopago' && (c.transferencia_alias || c.transferencia_cbu);
  $('#avisoCobro').hidden = Boolean(conMercadoPago || conTransferencia);
}

$('#avisoCobro').addEventListener('click', (e) => {
  if (e.target.closest('button')) showTab('ajustes');
});

$('#pedidosEstado').onchange = () => cargarPedidos();
$('#pedidosEvento').onchange = () => cargarPedidos();
let buscarPedidos;
$('#pedidosBuscar').oninput = () => { clearTimeout(buscarPedidos); buscarPedidos = setTimeout(cargarPedidos, 250); };

$('#pedidosLista').addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-accion]');
  if (!boton) return;
  let accion = boton.dataset.accion;
  if (accion === 'rechazar' && !confirmado(boton)) return;
  const body = {};
  if (accion === 'deshacer-ingreso') {
    accion = 'ingreso';
    body.deshacer = true;
  }
  boton.disabled = true;
  try {
    await api(`/api/admin/pedidos/${boton.dataset.id}/${accion}`, { method: 'POST', body });
    const avisos = {
      aprobar: 'Aprobado. Avisale por WhatsApp; cuando te pague, tocá "Marcar pagado".',
      rechazar: 'Rechazado. Podés avisarle por WhatsApp.',
      pagado: 'Marcado como pagado.',
      pendiente: 'Volvió a pendiente.',
      ingreso: body.deshacer ? 'Ingreso deshecho.' : 'Ingreso marcado.',
    };
    toast(avisos[accion]);
    await cargarPedidos();
  } catch (err) {
    toast(err.message);
    boton.disabled = false;
  }
});

// Mientras el panel está abierto en Pedidos, se actualiza solo cada 20 segundos.
setInterval(() => {
  if (!$('#panelView').hidden && panel.tab === 'pedidos' && !document.hidden) {
    cargarPedidos({ silencioso: true }).catch(() => {});
  }
}, 20000);

// ---------- Productos ----------

function vistaPrevia() {
  const precio = Validar.pesos($('#pPrecio').value.trim());
  $('#pVistaPrevia').textContent = !$('#pPrecio').value.trim()
    ? ''
    : Number.isNaN(precio)
      ? 'Precio inválido: usá solo números, sin centavos (ej. 15000 o 15.000).'
      : `En el catálogo se verá: ${fmtPesos(precio)} + ${fmtPesos(panel.recargo)} de recargo = ${fmtPesos(precio + panel.recargo)}`;
}

async function cargarProductos() {
  const { productos, recargo } = await api('/api/admin/productos');
  panel.productos = productos;
  panel.recargo = recargo;
  $('#recargo').value = recargo;
  vistaPrevia();
  $('#productosLista').innerHTML = productos.length ? productos.map((p) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(p.nombre)}
          <span class="chip ${p.activo ? 'on' : ''}">${p.activo ? 'Visible' : 'Oculto'}</span>
          ${p.precio ? '' : '<span class="chip estado-pendiente">Sin precio</span>'}</p>
        ${p.descripcion ? `<p class="item-sub">${esc(p.descripcion)}</p>` : ''}
        <p class="item-sub mono">${fmtPesos(p.precio)} + ${fmtPesos(recargo)} = ${fmtPesos(p.total)}</p>
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost small" data-activar="${p.id}">${p.activo ? 'Ocultar' : 'Mostrar'}</button>
        <button class="btn btn-ghost small" data-editar="${p.id}">Editar</button>
        <button class="btn btn-ghost small danger" data-borrar="${p.id}">Borrar</button>
      </div>
    </div>`).join('') : vacio('Todavía no hay productos.');
}

function editarProducto(p) {
  panel.editandoProducto = p;
  $('#productoTitulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
  $('#pNombre').value = p?.nombre || '';
  $('#pDescripcion').value = p?.descripcion || '';
  $('#pPrecio').value = p ? p.precio : '';
  $('#pOrden').value = p?.orden ?? 0;
  // Un producto que todavía no tenía precio se ofrece visible: al ponerle precio es para venderlo.
  $('#pActivo').checked = p ? Boolean(p.activo) || !p.precio : true;
  $('#productoCancelar').hidden = !p;
  $('#productoMessage').textContent = '';
  vistaPrevia();
}

$('#pPrecio').oninput = vistaPrevia;
$('#productoCancelar').onclick = () => editarProducto(null);

$('#productoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    nombre: $('#pNombre').value,
    descripcion: $('#pDescripcion').value,
    precio: $('#pPrecio').value.trim(),
    orden: Number($('#pOrden').value) || 0,
    activo: $('#pActivo').checked,
  };
  try {
    if (panel.editandoProducto) await api(`/api/admin/productos/${panel.editandoProducto.id}`, { method: 'PUT', body });
    else await api('/api/admin/productos', { method: 'POST', body });
    toast('Producto guardado');
    editarProducto(null);
    cargarProductos();
  } catch (err) {
    $('#productoMessage').textContent = err.message;
  }
});

$('#productosLista').addEventListener('click', async (e) => {
  const activar = e.target.closest('[data-activar]');
  const editar = e.target.closest('[data-editar]');
  const borrar = e.target.closest('[data-borrar]');
  try {
    if (editar) {
      editarProducto(panel.productos.find((p) => p.id === Number(editar.dataset.editar)));
      $('#productoForm').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (activar) {
      const p = panel.productos.find((x) => x.id === Number(activar.dataset.activar));
      if (!p.activo && !p.precio) return toast('Primero ponele precio (tocá Editar).');
      await api(`/api/admin/productos/${p.id}`, { method: 'PUT', body: { activo: !p.activo } });
    } else if (borrar && confirmado(borrar)) {
      await api(`/api/admin/productos/${borrar.dataset.borrar}`, { method: 'DELETE' });
      toast('Producto borrado');
    } else {
      return;
    }
    cargarProductos();
  } catch (err) {
    toast(err.message);
  }
});

$('#recargoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/configuracion', { method: 'PUT', body: { recargo: $('#recargo').value.trim() } });
    toast('Recargo guardado');
    cargarProductos();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- RRPP ----------

async function cargarRrpp() {
  panel.rrpp = (await api('/api/admin/rrpp')).rrpp;
  llenarSelects();
  $('#rrppLista').innerHTML = panel.rrpp.length ? panel.rrpp.map((r) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(r.nombre)} <span class="chip ${r.activo ? 'on' : ''}">${r.activo ? 'Activo' : 'Pausado'}</span></p>
        <p class="item-sub">Código <span class="mono">${esc(r.codigo)}</span></p>
        <p class="item-sub">${r.anotados} en su lista · ${r.pedidos} pedidos · ${fmtPesos(r.cobrado)} cobrado</p>
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost small" data-lista="${r.id}">Ver lista</button>
        <button class="btn btn-ghost small" data-activar="${r.id}">${r.activo ? 'Pausar' : 'Activar'}</button>
        <button class="btn btn-ghost small" data-editar="${r.id}">Editar</button>
        <button class="btn btn-ghost small danger" data-borrar="${r.id}">Borrar</button>
      </div>
    </div>`).join('') : vacio('No hay RRPP: nadie puede entrar con código.');
}

function editarRrpp(r) {
  panel.editandoRrpp = r;
  $('#rrppTitulo').textContent = r ? 'Editar RRPP' : 'Nuevo RRPP';
  $('#rNombre').value = r?.nombre || '';
  $('#rCodigo').value = r?.codigo || '';
  $('#rActivo').checked = r ? Boolean(r.activo) : true;
  $('#rrppCancelar').hidden = !r;
  $('#rrppMessage').textContent = '';
}

$('#rrppCancelar').onclick = () => editarRrpp(null);

$('#rrppForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { nombre: $('#rNombre').value, codigo: $('#rCodigo').value, activo: $('#rActivo').checked };
  try {
    if (panel.editandoRrpp) await api(`/api/admin/rrpp/${panel.editandoRrpp.id}`, { method: 'PUT', body });
    else await api('/api/admin/rrpp', { method: 'POST', body });
    toast('RRPP guardado');
    editarRrpp(null);
    cargarRrpp();
  } catch (err) {
    $('#rrppMessage').textContent = err.message;
  }
});

$('#rrppLista').addEventListener('click', async (e) => {
  const lista = e.target.closest('[data-lista]');
  const activar = e.target.closest('[data-activar]');
  const editar = e.target.closest('[data-editar]');
  const borrar = e.target.closest('[data-borrar]');
  try {
    if (lista) {
      $('#listasRrpp').value = lista.dataset.lista;
      return showTab('listas');
    }
    if (editar) {
      editarRrpp(panel.rrpp.find((r) => r.id === Number(editar.dataset.editar)));
      $('#rrppForm').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (activar) {
      const r = panel.rrpp.find((x) => x.id === Number(activar.dataset.activar));
      await api(`/api/admin/rrpp/${r.id}`, { method: 'PUT', body: { activo: !r.activo } });
    } else if (borrar && confirmado(borrar)) {
      await api(`/api/admin/rrpp/${borrar.dataset.borrar}`, { method: 'DELETE' });
      toast('RRPP borrado');
    } else {
      return;
    }
    cargarRrpp();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Listas de cada RRPP ----------

async function cargarListas() {
  const params = new URLSearchParams({
    rrpp: $('#listasRrpp').value,
    evento_id: $('#listasEvento').value,
    q: $('#listasBuscar').value.trim(),
  });
  const { lista } = await api(`/api/admin/listas?${params}`);
  $('#listasCsv').href = `/api/admin/listas.csv?${params}`;
  const compraron = lista.filter((l) => l.pagados).length;
  $('#listasResumen').innerHTML = `
    <div class="stat"><b>${lista.length}</b><span>Anotados</span></div>
    <div class="stat"><b>${compraron}</b><span>Compraron</span></div>
    <div class="stat"><b>${lista.length ? Math.round((compraron / lista.length) * 100) : 0}%</b><span>Conversión</span></div>`;
  $('#listasLista').innerHTML = lista.length ? lista.map((l) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(l.nombre)} ${l.pagados ? '<span class="chip on">Compró</span>' : ''}</p>
        <p class="item-sub"><a href="https://instagram.com/${esc(l.instagram)}" target="_blank" rel="noopener">@${esc(l.instagram)}</a>
          · ${esc(l.telefono)} · cumple ${dm(l.cumpleanos)}</p>
        <p class="item-sub">${esc(l.rrpp_nombre)} · ${esc(l.evento_nombre)} · anotado ${fechaHora(l.creado_en)}</p>
      </div>
      <div class="item-actions">
        ${botonWhatsApp(l.telefono, `Hola ${primerNombre(l.nombre)}! Te escribimos de ${panel.lugar} por ${l.evento_nombre}.`)}
      </div>
    </div>`).join('') : vacio('Nadie se anotó con ese filtro.');
}

$('#listasRrpp').onchange = () => cargarListas();
$('#listasEvento').onchange = () => cargarListas();
let buscarListas;
$('#listasBuscar').oninput = () => { clearTimeout(buscarListas); buscarListas = setTimeout(cargarListas, 250); };

// ---------- Clientes ----------

async function cargarClientes() {
  const mes = $('#clientesMes').value;
  const params = new URLSearchParams({ mes, q: $('#clientesBuscar').value.trim() });
  const { clientes } = await api(`/api/admin/clientes?${params}`);
  $('#clientesCsv').href = `/api/admin/clientes.csv?${params}`;
  const uno = clientes.length === 1;
  $('#clientesTotal').textContent = `${clientes.length} cliente${uno ? '' : 's'}${mes ? ` que ${uno ? 'cumple' : 'cumplen'} años en ${MESES[mes - 1].toLowerCase()}` : ''}`;
  const hoyMD = hoy().slice(5);
  $('#clientesLista').innerHTML = clientes.length ? clientes.map((c) => {
    const cumpleHoy = c.cumpleanos.slice(5) === hoyMD;
    const saludo = cumpleHoy
      ? `Hola ${primerNombre(c.nombre)}! Feliz cumple de parte de todo ${panel.lugar} 🎂`
      : `Hola ${primerNombre(c.nombre)}! Te escribimos de ${panel.lugar}.`;
    return `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(c.nombre)} ${cumpleHoy ? '<span class="chip estado-pendiente">Cumple hoy</span>' : ''}</p>
        <p class="item-sub"><a href="https://instagram.com/${esc(c.instagram)}" target="_blank" rel="noopener">@${esc(c.instagram)}</a> · ${esc(c.telefono)}</p>
        <p class="item-sub">Cumple ${dm(c.cumpleanos)} (${Validar.edad(c.cumpleanos, hoy())} años) · RRPP: ${esc(c.rrpp_nombre)} · registrado el ${fechaCorta(c.creado_en)}</p>
      </div>
      <div class="item-actions">${botonWhatsApp(c.telefono, saludo)}</div>
    </div>`;
  }).join('') : vacio(mes ? 'Nadie cumple años ese mes.' : 'Todavía no hay clientes registrados.');
}

$('#clientesMes').onchange = () => cargarClientes();
$('#cumplesDelMes').onclick = () => {
  $('#clientesMes').value = String(new Date().getMonth() + 1);
  cargarClientes();
};
let buscarClientes;
$('#clientesBuscar').oninput = () => { clearTimeout(buscarClientes); buscarClientes = setTimeout(cargarClientes, 250); };

// ---------- Fiestas ----------

async function cargarEventos() {
  panel.eventos = (await api('/api/admin/eventos')).eventos;
  llenarSelects();
  $('#eventosLista').innerHTML = panel.eventos.length ? panel.eventos.map((ev) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(ev.nombre)} <span class="chip ${ev.abierto ? 'on' : ''}">${ev.abierto ? 'Abierta' : 'Cerrada'}</span></p>
        <p class="item-sub">${esc(fmtEventDate(ev.fecha))} · ${ev.registrados} registrados${ev.cupo ? ` de ${ev.cupo}` : ''} · ${ev.pedidos} pedidos · ${fmtPesos(ev.cobrado)} cobrado</p>
        ${ev.direccion ? `<p class="item-sub">${esc(ev.direccion)}</p>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost small" data-abrir="${ev.id}">${ev.abierto ? 'Cerrar' : 'Abrir'}</button>
        <button class="btn btn-ghost small" data-editar="${ev.id}">Editar</button>
        <button class="btn btn-ghost small danger" data-borrar="${ev.id}">Borrar</button>
      </div>
    </div>`).join('') : vacio('Todavía no hay fiestas.');
}

function editarEvento(ev) {
  panel.editandoEvento = ev;
  $('#eventoTitulo').textContent = ev ? 'Editar fiesta' : 'Nueva fiesta';
  $('#eNombre').value = ev?.nombre || '';
  $('#eFecha').value = ev?.fecha || '';
  $('#eCupo').value = ev?.cupo ?? 0;
  $('#eDescripcion').value = ev?.descripcion || '';
  $('#eDireccion').value = ev?.direccion || '';
  $('#eAbierto').checked = ev ? Boolean(ev.abierto) : true;
  $('#eventoCancelar').hidden = !ev;
  $('#eventoMessage').textContent = '';
}

$('#eventoCancelar').onclick = () => editarEvento(null);

$('#eventoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    nombre: $('#eNombre').value,
    fecha: $('#eFecha').value,
    cupo: Number($('#eCupo').value) || 0,
    descripcion: $('#eDescripcion').value,
    direccion: $('#eDireccion').value,
    abierto: $('#eAbierto').checked,
  };
  try {
    if (panel.editandoEvento) await api(`/api/admin/eventos/${panel.editandoEvento.id}`, { method: 'PUT', body });
    else await api('/api/admin/eventos', { method: 'POST', body });
    toast('Fiesta guardada');
    editarEvento(null);
    cargarEventos();
  } catch (err) {
    $('#eventoMessage').textContent = err.message;
  }
});

$('#eventosLista').addEventListener('click', async (e) => {
  const abrir = e.target.closest('[data-abrir]');
  const editar = e.target.closest('[data-editar]');
  const borrar = e.target.closest('[data-borrar]');
  try {
    if (editar) {
      editarEvento(panel.eventos.find((ev) => ev.id === Number(editar.dataset.editar)));
      $('#eventoForm').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (abrir) {
      const ev = panel.eventos.find((x) => x.id === Number(abrir.dataset.abrir));
      await api(`/api/admin/eventos/${ev.id}`, { method: 'PUT', body: { abierto: !ev.abierto } });
    } else if (borrar && confirmado(borrar)) {
      await api(`/api/admin/eventos/${borrar.dataset.borrar}`, { method: 'DELETE' });
      toast('Fiesta borrada');
    } else {
      return;
    }
    cargarEventos();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Ajustes ----------

async function cargarAjustes() {
  const { configuracion, mercadoPagoConfigurado } = await api('/api/admin/configuracion');
  for (const input of $('#ajustesForm').elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') input.checked = Boolean(configuracion[input.name]);
    else input.value = configuracion[input.name] ?? '';
  }
  $('#mpEstado').textContent = mercadoPagoConfigurado
    ? 'Mercado Pago está conectado: al aprobar un pedido se genera el link de pago por el total exacto.'
    : 'Mercado Pago no está conectado (falta la variable MP_ACCESS_TOKEN). Mientras tanto se cobra por transferencia.';
}

$('#ajustesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#ajustesMessage').textContent = '';
  const body = {};
  for (const input of e.target.elements) {
    if (!input.name) continue;
    body[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  try {
    const { configuracion } = await api('/api/admin/configuracion', { method: 'PUT', body });
    $$('[data-club-name]').forEach((el) => { el.textContent = configuracion.nombre_lugar; });
    panel.lugar = configuracion.nombre_lugar;
    fitLogos();
    toast('Ajustes guardados');
    cargarAjustes();
  } catch (err) {
    $('#ajustesMessage').textContent = err.message;
  }
});

start();
