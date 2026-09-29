const puerta = { eventoId: '', filtro: 'faltan', datos: null };

const ESTADO_NO_PAGADO = {
  pendiente: 'Pedido sin aprobar',
  aprobado: 'Aprobado pero sin pagar',
  rechazado: 'Pedido rechazado',
};

const hora = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

function toast(texto, mal = false) {
  $$('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = `toast ${mal ? 'mal' : ''}`;
  el.textContent = texto;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---------- Sesión ----------

async function start() {
  try {
    const config = await api('/api/config');
    $$('[data-club-name]').forEach((el) => { el.textContent = config.nombre_lugar; });
  } catch { /* sigue igual */ }
  try {
    await cargar();
    $('#loginView').hidden = true;
    $('#puertaView').hidden = false;
    fitLogos();
    $('#buscar').focus();
  } catch {
    $('#loginView').hidden = false;
    $('#puertaView').hidden = true;
    fitLogos();
    setTimeout(() => $('#password').focus(), 50);
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginMessage').textContent = '';
  try {
    await api('/api/puerta/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    start();
  } catch (err) {
    $('#loginMessage').textContent = err.message;
  }
});

$('#salirBtn').onclick = async () => {
  await api('/api/puerta/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

// ---------- Lista ----------

async function cargar() {
  const params = new URLSearchParams({ evento_id: puerta.eventoId, q: $('#buscar').value.trim() });
  puerta.datos = await api(`/api/puerta?${params}`);
  render();
}

function fila(p) {
  const noPasa = p.estado !== 'pagado';
  const accion = noPasa
    ? `<p class="estado-puerta">✕ No pasa · ${esc(ESTADO_NO_PAGADO[p.estado] || p.estado)}</p>`
    : p.ingreso_en
      ? `<p class="estado-puerta"><span class="ok">✓ Entró a las ${hora(p.ingreso_en)}</span>
           <button class="link-btn" type="button" data-deshacer="${p.id}">Deshacer</button></p>`
      : `<button class="btn entro-btn" type="button" data-entro="${p.id}" data-nombre="${esc(p.nombre)}">Entró</button>`;
  return `
    <article class="fila ${noPasa ? 'no-pasa' : p.ingreso_en ? 'entro' : ''}">
      <div>
        <p class="fila-nombre">${esc(p.nombre)}</p>
        <p class="fila-sub"><span class="fila-codigo">${esc(p.codigo)}</span> · @${esc(p.instagram)}</p>
        <p class="fila-sub">${esc(p.items)}${p.rrpp_nombre ? ` · RRPP ${esc(p.rrpp_nombre)}` : ''}</p>
      </div>
      ${accion}
    </article>`;
}

function render() {
  const { eventos, evento, totales, pedidos, otros } = puerta.datos;
  const select = $('#evento');
  select.hidden = eventos.length < 2;
  select.innerHTML = eventos.map((ev) => `<option value="${ev.id}">${esc(ev.nombre)} · ${esc(fmtEventDate(ev.fecha))}</option>`).join('');
  if (evento) select.value = evento.id;

  $('#entraron').textContent = totales.entraron;
  $('#deTotal').textContent = `de ${totales.pagados} entraron${evento ? ` · ${evento.nombre}` : ''}`;
  $('#barra').style.width = `${totales.pagados ? (totales.entraron / totales.pagados) * 100 : 0}%`;

  const buscando = Boolean($('#buscar').value.trim());
  // Buscando se muestran todas las coincidencias; si no, según el filtro elegido.
  const visibles = buscando ? pedidos : pedidos.filter((p) =>
    puerta.filtro === 'todos' || (puerta.filtro === 'entraron' ? p.ingreso_en : !p.ingreso_en));
  const mensajeVacio = buscando
    ? 'No hay ningún pedido pagado con esos datos.'
    : { faltan: 'Ya entraron todos.', entraron: 'Todavía no entró nadie.', todos: 'No hay pedidos pagados para esta fecha.' }[puerta.filtro];
  $('#lista').innerHTML = [...otros.map(fila), ...visibles.map(fila)].join('') || `<p class="empty">${mensajeVacio}</p>`;
}

let esperaBusqueda;
$('#buscar').addEventListener('input', () => {
  clearTimeout(esperaBusqueda);
  esperaBusqueda = setTimeout(() => cargar().catch((err) => toast(err.message, true)), 200);
});

$('#evento').onchange = () => {
  puerta.eventoId = $('#evento').value;
  cargar().catch((err) => toast(err.message, true));
};

$$('[data-filtro]').forEach((boton) => {
  boton.onclick = () => {
    puerta.filtro = boton.dataset.filtro;
    $$('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b === boton)));
    render();
  };
});

$('#lista').addEventListener('click', async (e) => {
  const entro = e.target.closest('[data-entro]');
  const deshacer = e.target.closest('[data-deshacer]');
  const boton = entro || deshacer;
  if (!boton) return;
  boton.disabled = true;
  try {
    await api(`/api/puerta/${boton.dataset.entro || boton.dataset.deshacer}/ingreso`, { method: 'POST', body: { deshacer: Boolean(deshacer) } });
    if (entro) {
      toast(`✓ Entró ${entro.dataset.nombre}`);
      $('#buscar').value = ''; // listo para la próxima persona
    } else {
      toast('Ingreso deshecho');
    }
    await cargar();
    $('#buscar').focus();
  } catch (err) {
    toast(err.message, true);
    await cargar().catch(() => {});
  }
});

// Con varias personas en la puerta, cada teléfono se actualiza solo cada 10 segundos.
setInterval(() => {
  if (!$('#puertaView').hidden && !document.hidden) cargar().catch(() => {});
}, 10000);

start();
