const panel = { events: [], codes: [], editingEvent: null, editingCode: null, tab: 'list' };

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Botón de borrar en dos toques (sin ventanas de confirmación).
function armed(button) {
  if (button.dataset.armed) return true;
  button.dataset.armed = '1';
  const original = button.textContent;
  button.textContent = '¿Seguro?';
  setTimeout(() => { delete button.dataset.armed; button.textContent = original; }, 3000);
  return false;
}

// ---------- Sesión ----------

async function start() {
  try {
    const config = await api('/api/config');
    $$('[data-club-name]').forEach((el) => { el.textContent = config.clubName; });
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
  await loadEvents();
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
  start();
};

function showTab(tab) {
  panel.tab = tab;
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  ({ list: loadEntries, events: renderEvents, codes: loadCodes, settings: loadSettings })[tab]();
}

$$('[data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

// ---------- Lista / puerta ----------

async function loadEvents() {
  panel.events = (await api('/api/admin/events')).events;
  const select = $('#listEvent');
  const current = Number(select.value);
  // Por defecto, la próxima fiesta con lista abierta.
  const upcoming = [...panel.events].reverse().find((ev) => ev.listOpen) || panel.events[0];
  select.innerHTML = panel.events.map((ev) => `<option value="${ev.id}">${esc(ev.name)} · ${esc(fmtEventDate(ev.date))}</option>`).join('')
    || '<option value="">Sin fiestas</option>';
  select.value = panel.events.some((ev) => ev.id === current) ? current : upcoming?.id ?? '';
}

async function loadEntries() {
  const eventId = $('#listEvent').value;
  const event = panel.events.find((ev) => ev.id === Number(eventId));
  $('#exportBtn').href = eventId ? `/api/admin/entries.csv?eventId=${eventId}` : '#';
  if (!event) {
    $('#listStats').innerHTML = '';
    $('#entries').innerHTML = '<p class="empty">Creá una fiesta en la pestaña Fiestas.</p>';
    return;
  }
  const q = $('#listSearch').value.trim();
  const { entries } = await api(`/api/admin/entries?eventId=${eventId}&q=${encodeURIComponent(q)}`);
  const all = q ? (await api(`/api/admin/entries?eventId=${eventId}`)).entries : entries;
  const people = all.reduce((n, e) => n + 1 + e.guests, 0);
  const inside = all.filter((e) => e.checkedInAt).length;
  $('#listStats').innerHTML = `
    <div class="stat"><b>${all.length}${event.capacity ? `<small class="item-sub" style="display:inline"> / ${event.capacity}</small>` : ''}</b><span>Anotados</span></div>
    <div class="stat"><b>${people}</b><span>Personas</span></div>
    <div class="stat"><b>${inside}</b><span>Ingresaron</span></div>`;
  $('#entries').innerHTML = entries.length ? entries.map((e) => `
    <div class="item ${e.checkedInAt ? 'in' : ''}">
      <div class="item-main">
        <p class="item-title">${esc(e.name)}${e.guests ? ` <span class="chip">+${e.guests}</span>` : ''}</p>
        <p class="item-sub">DNI ${esc(e.dni)} · <span class="mono">${esc(e.pass)}</span>${e.instagram ? ` · @${esc(e.instagram)}` : ''}</p>
        <p class="item-sub">${esc(e.phone)} · vino por ${esc(e.codeLabel)}</p>
      </div>
      <div class="item-actions">
        <button class="btn small ${e.checkedInAt ? 'btn-ghost' : ''}" data-checkin="${e.id}" data-value="${e.checkedInAt ? '' : '1'}">
          ${e.checkedInAt ? 'Deshacer ingreso' : 'Marcar ingreso'}
        </button>
        <button class="btn btn-ghost small danger" data-remove="${e.id}">Borrar</button>
      </div>
    </div>`).join('') : `<p class="empty">${q ? 'No hay nadie con esos datos en la lista.' : 'Todavía no se anotó nadie.'}</p>`;
}

$('#listEvent').onchange = loadEntries;
let searchTimer;
$('#listSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadEntries, 200); };

$('#entries').addEventListener('click', async (e) => {
  const checkin = e.target.closest('[data-checkin]');
  const remove = e.target.closest('[data-remove]');
  if (checkin) {
    await api(`/api/admin/entries/${checkin.dataset.checkin}`, { method: 'PATCH', body: { checkedIn: Boolean(checkin.dataset.value) } });
    toast(checkin.dataset.value ? 'Ingreso marcado' : 'Ingreso deshecho');
    loadEntries();
  }
  if (remove && armed(remove)) {
    await api(`/api/admin/entries/${remove.dataset.remove}`, { method: 'DELETE' });
    toast('Borrado de la lista');
    loadEntries();
  }
});

// ---------- Fiestas ----------

function renderEvents() {
  $('#eventRows').innerHTML = panel.events.length ? panel.events.map((ev) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title">${esc(ev.name)} <span class="chip ${ev.listOpen ? 'on' : ''}">${ev.listOpen ? 'Lista abierta' : 'Lista cerrada'}</span></p>
        <p class="item-sub">${esc(fmtEventDate(ev.date))} · ${ev.entries} anotados${ev.capacity ? ` de ${ev.capacity}` : ''} · ${ev.people} personas</p>
        ${ev.address ? `<p class="item-sub">${esc(ev.address)}</p>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost small" data-toggle-event="${ev.id}">${ev.listOpen ? 'Cerrar lista' : 'Abrir lista'}</button>
        <button class="btn btn-ghost small" data-edit-event="${ev.id}">Editar</button>
        <button class="btn btn-ghost small danger" data-delete-event="${ev.id}">Borrar</button>
      </div>
    </div>`).join('') : '<p class="empty">Todavía no hay fiestas.</p>';
}

function fillEventForm(ev) {
  panel.editingEvent = ev;
  $('#eventFormTitle').textContent = ev ? 'Editar fiesta' : 'Nueva fiesta';
  $('#evName').value = ev?.name || '';
  $('#evDate').value = ev?.date || '';
  $('#evCapacity').value = ev?.capacity ?? 200;
  $('#evDesc').value = ev?.description || '';
  $('#evAddress').value = ev?.address || '';
  $('#evOpen').checked = ev ? ev.listOpen : true;
  $('#eventCancel').hidden = !ev;
  $('#eventMessage').textContent = '';
}

$('#eventCancel').onclick = () => fillEventForm(null);

$('#eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#evName').value,
    date: $('#evDate').value,
    capacity: Number($('#evCapacity').value),
    description: $('#evDesc').value,
    address: $('#evAddress').value,
    listOpen: $('#evOpen').checked,
  };
  try {
    if (panel.editingEvent) await api(`/api/admin/events/${panel.editingEvent.id}`, { method: 'PUT', body });
    else await api('/api/admin/events', { method: 'POST', body });
    toast('Fiesta guardada');
    fillEventForm(null);
    await loadEvents();
    renderEvents();
  } catch (err) {
    $('#eventMessage').textContent = err.message;
  }
});

$('#eventRows').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-event]');
  const toggle = e.target.closest('[data-toggle-event]');
  const del = e.target.closest('[data-delete-event]');
  if (edit) {
    fillEventForm(panel.events.find((ev) => ev.id === Number(edit.dataset.editEvent)));
    $('#eventForm').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (toggle) {
    const ev = panel.events.find((x) => x.id === Number(toggle.dataset.toggleEvent));
    await api(`/api/admin/events/${ev.id}`, { method: 'PUT', body: { listOpen: !ev.listOpen } });
  } else if (del && armed(del)) {
    await api(`/api/admin/events/${del.dataset.deleteEvent}`, { method: 'DELETE' });
    toast('Fiesta borrada');
  } else {
    return;
  }
  await loadEvents();
  renderEvents();
});

// ---------- Códigos ----------

async function loadCodes() {
  panel.codes = (await api('/api/admin/codes')).codes;
  $('#codeRows').innerHTML = panel.codes.length ? panel.codes.map((c) => `
    <div class="item">
      <div class="item-main">
        <p class="item-title"><span class="mono">${esc(c.code)}</span> <span class="chip ${c.active ? 'on' : ''}">${c.active ? 'Activo' : 'Pausado'}</span></p>
        <p class="item-sub">${esc(c.label || 'Sin nombre')} · ${c.uses} ingresos${c.maxUses ? ` de ${c.maxUses}` : ''} · ${c.signups} anotados</p>
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost small" data-toggle-code="${c.id}">${c.active ? 'Pausar' : 'Activar'}</button>
        <button class="btn btn-ghost small" data-edit-code="${c.id}">Editar</button>
        <button class="btn btn-ghost small danger" data-delete-code="${c.id}">Borrar</button>
      </div>
    </div>`).join('') : '<p class="empty">No hay códigos: nadie puede entrar.</p>';
}

function fillCodeForm(c) {
  panel.editingCode = c;
  $('#codeFormTitle').textContent = c ? 'Editar código' : 'Nuevo código';
  $('#cdCode').value = c?.code || '';
  $('#cdLabel').value = c?.label || '';
  $('#cdMax').value = c?.maxUses ?? 0;
  $('#cdActive').checked = c ? c.active : true;
  $('#codeCancel').hidden = !c;
  $('#codeMessage').textContent = '';
}

$('#codeCancel').onclick = () => fillCodeForm(null);

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { code: $('#cdCode').value, label: $('#cdLabel').value, maxUses: Number($('#cdMax').value), active: $('#cdActive').checked };
  try {
    if (panel.editingCode) await api(`/api/admin/codes/${panel.editingCode.id}`, { method: 'PUT', body });
    else await api('/api/admin/codes', { method: 'POST', body });
    toast('Código guardado');
    fillCodeForm(null);
    loadCodes();
  } catch (err) {
    $('#codeMessage').textContent = err.message;
  }
});

$('#codeRows').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-code]');
  const toggle = e.target.closest('[data-toggle-code]');
  const del = e.target.closest('[data-delete-code]');
  if (edit) {
    fillCodeForm(panel.codes.find((c) => c.id === Number(edit.dataset.editCode)));
    $('#codeForm').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (toggle) {
    const c = panel.codes.find((x) => x.id === Number(toggle.dataset.toggleCode));
    await api(`/api/admin/codes/${c.id}`, { method: 'PUT', body: { active: !c.active } });
  } else if (del && armed(del)) {
    await api(`/api/admin/codes/${del.dataset.deleteCode}`, { method: 'DELETE' });
    toast('Código borrado');
  } else {
    return;
  }
  loadCodes();
});

// ---------- Ajustes ----------

async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  for (const input of $('#settingsForm').elements) {
    if (input.name) input.value = settings[input.name] ?? '';
  }
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const input of e.target.elements) if (input.name) body[input.name] = input.type === 'number' ? Number(input.value) : input.value;
  const { settings } = await api('/api/admin/settings', { method: 'PUT', body });
  $$('[data-club-name]').forEach((el) => { el.textContent = settings.clubName; });
  fitLogos();
  toast('Ajustes guardados');
});

start();
