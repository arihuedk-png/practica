const PEDIDOS_KEY = 'pedidos';
const SECCIONES = ['gate', 'registro', 'catalogo', 'pedidos'];
const CAMPOS = ['nombre', 'instagram', 'cumpleanos', 'telefono', 'consentimiento'];
const ESTADOS = {
  pendiente: { titulo: 'Pendiente de aprobación', texto: 'La producción lo está revisando. Esta página se actualiza sola.' },
  aprobado: { titulo: 'Aprobado · falta pagar', texto: 'Pagalo para confirmar tu lugar.' },
  rechazado: { titulo: 'No aprobado', texto: 'La producción no pudo aprobar este pedido.' },
  pagado: { titulo: 'Pagado', texto: 'Mostrá este código y tu DNI en la puerta.' },
};
const state = { config: {}, sesion: null, eventoId: null, productos: [], cantidades: new Map(), poll: null };

function show(id) {
  for (const seccion of SECCIONES) $(`#${seccion}`).hidden = seccion !== id;
  clearTimeout(state.poll);
  fitLogos();
  window.scrollTo(0, 0);
  if (id === 'gate') {
    $('#verMisPedidos').hidden = !pedidosGuardados().length;
    setTimeout(() => $('#code').focus(), 50);
  }
}

function volverALaPuerta(mensaje = 'Pasó mucho tiempo. Poné el código de nuevo.') {
  show('gate');
  $('#codeMessage').textContent = mensaje;
}

// Si el servidor dice que falta el código o el registro, lleva a esa pantalla.
function segunMotivo(err) {
  if (err.motivo === 'acceso') {
    volverALaPuerta();
    return true;
  }
  if (err.motivo === 'registro') {
    continuar().catch(() => show('gate'));
    return true;
  }
  return false;
}

// Botón que pide un segundo toque para confirmar (las ventanas de confirmación no siempre andan en el celular).
function confirmado(boton, texto = '¿Seguro? Tocá de nuevo') {
  if (boton.dataset.armado) return true;
  boton.dataset.armado = '1';
  const original = boton.textContent;
  boton.textContent = texto;
  setTimeout(() => { delete boton.dataset.armado; boton.textContent = original; }, 3000);
  return false;
}

const waLink = (tel, texto) => `https://wa.me/${tel.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;

// ---------- Puerta ----------

function strobe() {
  const flash = document.createElement('div');
  flash.className = 'strobe';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 700);
}

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#code');
  const button = $('#enterBtn');
  $('#codeMessage').textContent = '';
  button.disabled = true;
  try {
    await api('/api/acceso', { method: 'POST', body: { codigo: input.value } });
    input.value = '';
    strobe();
    await continuar();
  } catch (err) {
    $('#codeMessage').textContent = err.message;
    input.classList.remove('shake');
    void input.offsetWidth; // reinicia la animación
    input.classList.add('shake');
    input.select();
  } finally {
    button.disabled = false;
  }
});

$('#sinCodigo').onclick = async () => {
  try {
    await api('/api/acceso/sin-rrpp', { method: 'POST' });
    await continuar();
  } catch (err) {
    $('#codeMessage').textContent = err.message;
  }
};

$('#verMisPedidos').onclick = () => abrirPedidos();

// Decide qué mostrar según el código y el registro.
async function continuar() {
  const sesion = await api('/api/sesion');
  state.sesion = sesion;
  if (!sesion.acceso) return show('gate');
  if (sesion.cliente && sesion.eventos.length === 1) return entrarComoConocido(sesion.eventos[0].id);
  return mostrarRegistro();
}

// ---------- Registro ----------

function eventHtml(ev) {
  const fecha = parseLocal(ev.fecha);
  const dia = fecha.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  const hora = fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `
    <div class="event-head">
      <h2 class="event-name">${esc(ev.nombre)}</h2>
      ${ev.descripcion ? `<p class="event-desc">${esc(ev.descripcion)}</p>` : ''}
    </div>
    <dl class="event-data">
      <div><dt>Fecha</dt><dd>${esc(dia)}</dd></div>
      <div><dt>Puerta</dt><dd>${esc(hora)} h</dd></div>
      <div><dt>Lugar</dt><dd>A revelar</dd></div>
    </dl>`;
}

function mostrarRegistro(mensaje = '') {
  const { eventos, cliente, anotado } = state.sesion;
  const disponible = (ev) => !ev.lleno || anotado.includes(ev.id);
  const form = $('#registroForm');

  if (!eventos.length) {
    const ig = state.config.instagram;
    $('#registroEvento').innerHTML = `
      <div class="event"><div class="event-head">
        <h2 class="event-name">Por ahora, nada</h2>
        <p class="event-desc">${ig ? `La próxima fecha sale primero en <a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">@${esc(ig)}</a>.` : 'La próxima fecha se abre pronto. Guardá el código.'}</p>
      </div></div>`;
    form.hidden = true;
    return show('registro');
  }

  form.hidden = false;
  const picker = $('#eventPicker');
  if (eventos.length === 1) {
    const ev = eventos[0];
    $('#registroEvento').innerHTML = `<div class="event">${eventHtml(ev)}</div>`;
    picker.hidden = true;
    picker.innerHTML = `<input type="radio" name="evento" value="${ev.id}" checked>`;
    if (!disponible(ev)) mensaje = mensaje || 'Se llenó el cupo de esta fecha.';
  } else {
    $('#registroEvento').innerHTML = '<div class="event"><div class="event-head"><h2 class="event-name">Hay más de una fecha</h2><p class="event-desc">Elegí a cuál venís.</p></div></div>';
    picker.hidden = false;
    const primera = eventos.find(disponible);
    picker.innerHTML = eventos.map((ev) => `
      <label><input type="radio" name="evento" value="${ev.id}" ${ev === primera ? 'checked' : ''} ${disponible(ev) ? '' : 'disabled'}>
        <span><b>${esc(ev.nombre)}</b><small>${esc(fmtEventDate(ev.fecha))}${disponible(ev) ? '' : ' · se llenó'}</small></span></label>`).join('');
  }

  $('#datosNuevos').hidden = Boolean(cliente);
  $('#clienteConocido').hidden = !cliente;
  if (cliente) $('#clienteNombre').textContent = cliente.nombre;
  $('#registroBtn').textContent = cliente ? 'Continuar' : 'Registrarme';
  $('#registroMessage').textContent = mensaje;
  show('registro');
}

const eventoElegido = () => Number($('input[name=evento]:checked')?.value) || 0;
const fechaElegida = () => state.sesion?.eventos.find((ev) => ev.id === eventoElegido())?.fecha;

function leerFormulario() {
  return {
    nombre: $('#nombre').value,
    instagram: $('#instagram').value,
    cumpleanos: $('#cumpleanos').value,
    telefono: $('#telefono').value,
    consentimiento: $('#consentimiento').checked,
  };
}

function errorDeCampo(campo, mensaje) {
  const input = $(`#${campo}`);
  $(`#error-${campo}`).textContent = mensaje || '';
  input.classList.toggle('invalid', Boolean(mensaje));
  input.setAttribute('aria-invalid', mensaje ? 'true' : 'false');
}

function validar() {
  return Validar.registro(leerFormulario(), { edadMinima: state.config.edad_minima, referencia: fechaElegida() });
}

// Al salir de un campo se avisa si el formato está mal (los que faltan se marcan al tocar "Registrarme",
// así el botón no se mueve justo cuando lo tocás). El error se borra apenas se corrige.
const vacio = (campo) => !$(`#${campo}`).value.trim() || $(`#${campo}`).value.trim() === '+54 9';
for (const campo of CAMPOS.filter((c) => c !== 'consentimiento')) {
  const input = $(`#${campo}`);
  const revisar = () => errorDeCampo(campo, validar().errores?.[campo]);
  input.addEventListener('blur', () => {
    if (!vacio(campo)) revisar();
  });
  input.addEventListener('input', () => {
    if (input.classList.contains('invalid')) revisar();
  });
}
$('#consentimiento').addEventListener('change', () => {
  if ($('#consentimiento').checked) errorDeCampo('consentimiento', '');
});

$('#verConsentimiento').onclick = () => {
  const texto = $('#textoConsentimiento');
  texto.hidden = !texto.hidden;
  $('#verConsentimiento').setAttribute('aria-expanded', String(!texto.hidden));
  $('#verConsentimiento').textContent = texto.hidden ? 'Leer el aviso' : 'Ocultar el aviso';
};

$('#noSoyYo').onclick = async () => {
  await api('/api/salir', { method: 'POST' }).catch(() => {});
  state.sesion.cliente = null;
  state.sesion.anotado = [];
  mostrarRegistro();
};

async function entrarComoConocido(eventoId) {
  try {
    if (!state.sesion.anotado.includes(eventoId)) {
      await api('/api/lista', { method: 'POST', body: { evento_id: eventoId } });
      state.sesion.anotado.push(eventoId);
    }
    await abrirCatalogo(eventoId);
  } catch (err) {
    if (!segunMotivo(err)) mostrarRegistro(err.message);
  }
}

$('#registroForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#registroBtn');
  const eventoId = eventoElegido();
  $('#registroMessage').textContent = '';
  if (!eventoId) {
    $('#registroMessage').textContent = 'Elegí una fecha.';
    return;
  }
  if (state.sesion.cliente) {
    button.disabled = true;
    await entrarComoConocido(eventoId);
    button.disabled = false;
    return;
  }

  const { valores, errores } = validar();
  for (const campo of CAMPOS) errorDeCampo(campo, errores?.[campo]);
  if (errores) {
    $('#registroMessage').textContent = 'Revisá los datos marcados.';
    $(`#${CAMPOS.find((campo) => errores[campo])}`).focus();
    return;
  }

  button.disabled = true;
  try {
    await api('/api/registro', { method: 'POST', body: { ...valores, evento_id: eventoId } });
    $('#registroForm').reset();
    $('#telefono').value = '+54 9 ';
    await abrirCatalogo(eventoId);
  } catch (err) {
    if (segunMotivo(err)) return;
    for (const campo of CAMPOS) errorDeCampo(campo, err.campos?.[campo]);
    $('#registroMessage').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// ---------- Catálogo ----------

async function abrirCatalogo(eventoId) {
  const { evento, productos } = await api(`/api/catalogo?evento_id=${eventoId}`);
  state.eventoId = evento.id;
  state.productos = productos;
  state.cantidades = new Map();
  $('#catalogoEvento').innerHTML = `<div class="event">${eventHtml(evento)}</div>`;
  $('#catalogoMessage').textContent = '';
  const guardados = pedidosGuardados().length;
  $('#avisoPedidos').hidden = !guardados;
  $('#avisoPedidos').innerHTML = `<span>Tenés ${guardados} pedido${guardados === 1 ? '' : 's'} en este teléfono.</span>
    <button class="link-btn" type="button" id="irAPedidos">Ver</button>`;
  renderProductos();
  show('catalogo');
}

function renderProductos() {
  if (!state.productos.length) {
    $('#productos').innerHTML = `<div class="event"><div class="event-head">
      <h2 class="event-name">Todavía no hay nada a la venta</h2>
      <p class="event-desc">Volvé a pasar en un rato.</p></div></div>`;
    $('#orderBar').hidden = true;
    return;
  }
  $('#productos').innerHTML = state.productos.map((p) => {
    const cantidad = state.cantidades.get(p.id) || 0;
    return `
      <article class="product ${cantidad ? 'selected' : ''}">
        <div class="product-head">
          <div class="product-info">
            <h2 class="product-name">${esc(p.nombre)}</h2>
            ${p.descripcion ? `<p class="product-desc">${esc(p.descripcion)}</p>` : ''}
          </div>
          <div class="stepper" role="group" aria-label="Cantidad de ${esc(p.nombre)}">
            <button type="button" data-menos="${p.id}" aria-label="Quitar uno" ${cantidad ? '' : 'disabled'}>−</button>
            <output aria-live="polite">${cantidad}</output>
            <button type="button" data-mas="${p.id}" aria-label="Agregar uno" ${cantidad >= 10 ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <dl class="breakdown">
          <div><dt>Precio</dt><dd>${fmtPesos(p.precio)}</dd></div>
          <div><dt>Recargo</dt><dd>+ ${fmtPesos(p.recargo)}</dd></div>
          <div><dt>Total</dt><dd>${fmtPesos(p.total)}</dd></div>
        </dl>
      </article>`;
  }).join('');
  renderResumen();
}

function renderResumen() {
  const elegidos = state.productos.filter((p) => state.cantidades.get(p.id));
  $('#orderBar').hidden = !elegidos.length;
  if (!elegidos.length) return;
  const total = elegidos.reduce((suma, p) => suma + p.total * state.cantidades.get(p.id), 0);
  $('#orderCount').textContent = elegidos.map((p) => `${state.cantidades.get(p.id)} × ${p.nombre}`).join(' · ');
  $('#orderTotal').textContent = fmtPesos(total);
}

$('#productos').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-mas], [data-menos]');
  if (!boton) return;
  const productoId = Number(boton.dataset.mas || boton.dataset.menos);
  const actual = state.cantidades.get(productoId) || 0;
  state.cantidades.set(productoId, Math.max(0, Math.min(10, actual + (boton.dataset.mas ? 1 : -1))));
  renderProductos();
});

$('#avisoPedidos').addEventListener('click', (e) => {
  if (e.target.closest('#irAPedidos')) abrirPedidos();
});

$('#pedirBtn').onclick = async () => {
  const items = [...state.cantidades]
    .filter(([, cantidad]) => cantidad > 0)
    .map(([producto_id, cantidad]) => ({ producto_id, cantidad }));
  if (!items.length) return;
  const button = $('#pedirBtn');
  button.disabled = true;
  $('#catalogoMessage').textContent = '';
  try {
    const { pedido } = await api('/api/pedidos', { method: 'POST', body: { evento_id: state.eventoId, items } });
    guardarPedido(pedido);
    await abrirPedidos('Recibimos tu pedido. Te avisamos cuando la producción lo revise.');
  } catch (err) {
    if (!segunMotivo(err)) $('#catalogoMessage').textContent = err.message;
  } finally {
    button.disabled = false;
  }
};

// ---------- Mis pedidos ----------
// Se guardan en el teléfono (número + clave secreta), así nadie más puede verlos.

const pedidosGuardados = () => store.get(PEDIDOS_KEY) || [];

function guardarPedido({ id, token }) {
  const lista = pedidosGuardados().filter((p) => p.id !== id);
  lista.unshift({ id, token });
  store.set(PEDIDOS_KEY, lista.slice(0, 20));
}

async function cargarPedidos() {
  const guardados = pedidosGuardados();
  const resultados = await Promise.all(guardados.map((p) =>
    api(`/api/pedidos/${p.id}?t=${encodeURIComponent(p.token)}`)
      .then((r) => r.pedido)
      .catch((err) => (err.status === 404 ? null : undefined))));
  // Se olvidan los que ya no existen (404); si falló la conexión se conservan.
  store.set(PEDIDOS_KEY, guardados.filter((_, i) => resultados[i] !== null));
  return resultados.filter(Boolean);
}

function copiable(etiqueta, visible, valor = visible) {
  return `<div class="copy-row">
    <span class="copy-label">${etiqueta}</span>
    <span class="copy-value">${esc(visible)}</span>
    <button type="button" class="copy-btn" data-copiar="${esc(valor)}">Copiar</button>
  </div>`;
}

function pagoHtml(p) {
  const { mercadopago, transferencia } = p.pago || {};
  const partes = [];
  if (mercadopago) {
    partes.push(`<a class="btn" href="${esc(mercadopago)}" target="_blank" rel="noopener">Pagar ${fmtPesos(p.total)} con Mercado Pago</a>`);
  }
  if (transferencia) {
    partes.push(`
      <div class="transfer">
        <p class="lbl">${mercadopago ? 'O por transferencia' : 'Pagá por transferencia'}</p>
        ${copiable('Monto', fmtPesos(p.total), String(p.total))}
        ${transferencia.alias ? copiable('Alias', transferencia.alias) : ''}
        ${transferencia.cbu ? copiable('CBU/CVU', transferencia.cbu) : ''}
        ${transferencia.titular ? `<p class="transfer-note">A nombre de ${esc(transferencia.titular)}.</p>` : ''}
        <p class="transfer-note">Poné <b>${esc(p.codigo)}</b> en el concepto.</p>
      </div>`);
    if (p.whatsapp) {
      partes.push(`<a class="btn btn-ghost" href="${waLink(p.whatsapp, `Hola! Te mando el comprobante del pedido ${p.codigo} (${fmtPesos(p.total)}).`)}" target="_blank" rel="noopener">Mandar el comprobante por WhatsApp</a>`);
    }
  }
  if (!partes.length) {
    const contacto = p.whatsapp
      ? `Si tarda, <a href="${waLink(p.whatsapp, `Hola! ¿Cómo pago el pedido ${p.codigo}?`)}" target="_blank" rel="noopener">escribinos por WhatsApp</a>.`
      : 'Volvé a mirar en un rato.';
    partes.push(`<p class="note">Estamos preparando el pago. ${contacto}</p>`);
  }
  return `<div class="pay">${partes.join('')}</div>`;
}

function pedidoHtml(p) {
  const estado = ESTADOS[p.estado];
  const fila = (etiqueta, valor) => (valor ? `<div><dt>${etiqueta}</dt><dd>${esc(valor)}</dd></div>` : '');
  const lugar = p.evento.direccion || (['pendiente', 'aprobado'].includes(p.estado) ? 'Se revela al pagar' : '');
  const items = p.items.map((i) => `
    <li>
      <span>${i.cantidad} × ${esc(i.nombre)}</span>
      <span class="mono">${fmtPesos(i.subtotal)}</span>
      <small>(${fmtPesos(i.precio)} + ${fmtPesos(i.recargo)} recargo)${i.cantidad > 1 ? ` × ${i.cantidad}` : ''}</small>
    </li>`).join('');
  const consulta = p.estado === 'rechazado' && p.whatsapp
    ? `<a class="btn btn-ghost" href="${waLink(p.whatsapp, `Hola! Consulto por mi pedido ${p.codigo}.`)}" target="_blank" rel="noopener">Consultar por WhatsApp</a>`
    : '';
  return `
    <article class="pass estado-${p.estado} ${p.ingreso ? 'in' : ''}">
      <div class="pass-top">
        <p class="pass-status">${esc(p.ingreso ? 'Ya entraste' : estado.titulo)}</p>
        <p class="pass-code ${p.estado === 'pagado' ? '' : 'pass-code-sm'}" aria-label="Código del pedido">${esc(p.codigo)}</p>
        <p class="pass-hint">${esc(estado.texto)}</p>
      </div>
      <div class="pass-cut"></div>
      <div class="pass-body">
        <ul class="lines">${items}</ul>
        <p class="lines-total"><span>Total</span><span class="mono">${fmtPesos(p.total)}</span></p>
        ${p.estado === 'aprobado' ? pagoHtml(p) : ''}
        ${consulta}
      </div>
      <dl class="pass-data">
        ${fila('Fiesta', p.evento.nombre)}
        ${fila('Cuándo', fmtEventDate(p.evento.fecha))}
        ${fila('Dónde', lugar)}
        ${fila('Nombre', p.cliente.nombre)}
      </dl>
    </article>`;
}

function renderPedidos(pedidos) {
  $('#listaPedidos').innerHTML = pedidos.length
    ? pedidos.map(pedidoHtml).join('')
    : '<p class="note">No hay pedidos guardados en este teléfono.</p>';
  $('#olvidarPedidos').hidden = !pedidos.length;
}

// Mientras haya pedidos esperando aprobación o pago, se actualiza sola cada 15 segundos.
function programarRefresco(pedidos) {
  clearTimeout(state.poll);
  if (!pedidos.some((p) => p.estado === 'pendiente' || p.estado === 'aprobado')) return;
  state.poll = setTimeout(async () => {
    if ($('#pedidos').hidden) return;
    const nuevos = await cargarPedidos();
    renderPedidos(nuevos);
    programarRefresco(nuevos);
  }, 15000);
}

async function abrirPedidos(nota = '', pedidos = null) {
  pedidos ??= await cargarPedidos();
  $('#pedidosNota').textContent = nota;
  $('#pedidosNota').hidden = !nota;
  renderPedidos(pedidos);
  show('pedidos');
  programarRefresco(pedidos);
}

$('#listaPedidos').addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-copiar]');
  if (!boton) return;
  try {
    await navigator.clipboard.writeText(boton.dataset.copiar);
    boton.textContent = 'Copiado';
  } catch {
    const valor = boton.parentElement.querySelector('.copy-value');
    getSelection().selectAllChildren(valor);
    boton.textContent = 'Seleccionado';
  }
  setTimeout(() => { boton.textContent = 'Copiar'; }, 2000);
});

$('#otroPedido').onclick = () => continuar().catch(() => show('gate'));

$('#olvidarPedidos').onclick = (e) => {
  if (!confirmado(e.currentTarget)) return;
  store.remove(PEDIDOS_KEY);
  renderPedidos([]);
};

// ---------- Inicio ----------

async function init() {
  try {
    const config = await api('/api/config');
    state.config = config;
    document.title = config.nombre_lugar;
    $$('[data-club-name]').forEach((el) => { el.textContent = config.nombre_lugar; });
    fitLogos();
    $('#gateLine1').textContent = config.texto_puerta_1;
    $('#gateLine2').textContent = config.texto_puerta_2;
    $('#footer').textContent = config.texto_pie;
    $('#ageTag').textContent = config.edad_minima ? `+${config.edad_minima}` : '';
    $('#sinCodigo').hidden = !config.permitir_sin_rrpp;
    $('#textoConsentimiento').textContent = config.consentimiento;
  } catch { /* se muestra igual */ }

  // Link de un pedido (por ejemplo, el que manda la producción por WhatsApp).
  const params = new URLSearchParams(location.search);
  const pedidoId = Number(params.get('pedido'));
  if (pedidoId && params.get('t')) {
    guardarPedido({ id: pedidoId, token: params.get('t') });
    history.replaceState(null, '', location.pathname);
    return abrirPedidos();
  }

  // Si vuelve con un pedido esperando aprobación o pago, primero ve cómo va.
  if (pedidosGuardados().length) {
    const pedidos = await cargarPedidos();
    if (pedidos.some((p) => p.estado === 'pendiente' || p.estado === 'aprobado')) return abrirPedidos('', pedidos);
  }

  try {
    await continuar();
  } catch {
    show('gate');
  }
}

init();
