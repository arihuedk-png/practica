const PASSES_KEY = 'pases';
const state = { events: [], minAge: 18, config: {} };

function show(id) {
  for (const section of ['gate', 'inside', 'passView']) $(`#${section}`).hidden = section !== id;
  fitLogos();
  if (id === 'gate') setTimeout(() => $('#code').focus(), 50);
}

// ---------- Puerta ----------

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#code');
  const button = $('#enterBtn');
  $('#codeMessage').textContent = '';
  button.disabled = true;
  try {
    await api('/api/unlock', { method: 'POST', body: { code: input.value } });
    input.value = '';
    strobe();
    await openInside();
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

function strobe() {
  const flash = document.createElement('div');
  flash.className = 'strobe';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 700);
}

// ---------- Adentro ----------

function eventHtml(ev) {
  const date = parseLocal(ev.date);
  const day = date.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  const time = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `
    <div class="event-head">
      <h2 class="event-name">${esc(ev.name)}</h2>
      ${ev.description ? `<p class="event-desc">${esc(ev.description)}</p>` : ''}
    </div>
    <dl class="event-data">
      <div><dt>Fecha</dt><dd>${esc(day)}</dd></div>
      <div><dt>Puerta</dt><dd>${esc(time)} h</dd></div>
      <div><dt>Lugar</dt><dd>A revelar</dd></div>
    </dl>`;
}

function renderEvents() {
  const open = state.events.filter((ev) => ev.listOpen);
  const form = $('#listForm');
  if (!open.length) {
    const full = state.events.some((ev) => ev.full);
    const ig = state.config.instagram;
    $('#eventBox').innerHTML = `
      <div class="event"><div class="event-head">
        <h2 class="event-name">${full ? 'Se llenó la lista' : 'Por ahora, nada'}</h2>
        <p class="event-desc">${ig ? `La próxima fecha sale primero en <a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">@${esc(ig)}</a>.` : 'La próxima fecha se abre pronto. Guardá el código.'}</p>
      </div></div>`;
    form.hidden = true;
    return;
  }
  form.hidden = false;
  if (open.length === 1) {
    $('#eventBox').innerHTML = `<div class="event">${eventHtml(open[0])}</div>`;
    $('#eventPicker').hidden = true;
    $('#eventPicker').innerHTML = `<input type="radio" name="eventId" value="${open[0].id}" checked>`;
  } else {
    $('#eventBox').innerHTML = '<div class="event"><div class="event-head"><h2 class="event-name">Hay más de una fecha</h2><p class="event-desc">Elegí a cuál venís.</p></div></div>';
    $('#eventPicker').hidden = false;
    $('#eventPicker').innerHTML = open.map((ev, i) => `
      <label><input type="radio" name="eventId" value="${ev.id}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(ev.name)}</b><small>${esc(fmtEventDate(ev.date))}</small></span></label>`).join('');
  }
}

async function openInside() {
  const { events, minAge } = await api('/api/events');
  state.events = events;
  state.minAge = minAge;
  renderEvents();
  $('#listMessage').textContent = '';
  show('inside');
  setTimeout(() => $('#name').focus({ preventScroll: true }), 50);
}

$('#listForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#listBtn');
  $('#listMessage').textContent = '';
  const required = ['name', 'dni', 'birthdate', 'phone'].find((id) => !$(`#${id}`).value.trim());
  if (required) {
    $('#listMessage').textContent = 'Faltan datos. Sin eso no te podemos anotar.';
    $(`#${required}`).focus();
    return;
  }
  button.disabled = true;
  try {
    const { entry, existing } = await api('/api/entries', {
      method: 'POST',
      body: {
        eventId: Number($('input[name=eventId]:checked')?.value),
        name: $('#name').value,
        dni: $('#dni').value,
        birthdate: $('#birthdate').value,
        phone: $('#phone').value,
        instagram: $('#instagram').value,
        guests: Number($('#guests').value),
      },
    });
    const passes = (store.get(PASSES_KEY) || []).filter((p) => p.id !== entry.id);
    passes.unshift({ id: entry.id, token: entry.token });
    store.set(PASSES_KEY, passes.slice(0, 10));
    $('#listForm').reset();
    renderPasses([entry], existing ? 'Ya estabas anotado/a' : null);
  } catch (err) {
    if (err.status === 401) {
      show('gate');
      $('#codeMessage').textContent = 'Pasó mucho tiempo. Poné el código de nuevo.';
    } else {
      $('#listMessage').textContent = err.message;
    }
  } finally {
    button.disabled = false;
  }
});

// ---------- Pase ----------

function passHtml(entry, status) {
  const ev = entry.event || {};
  const row = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
  return `
    <div class="pass-top">
      <p class="pass-status">${esc(status || (entry.checkedIn ? 'Ya entraste' : 'En lista'))}</p>
      <p class="pass-name">${esc(entry.name)}</p>
      ${entry.guests ? `<p class="pass-guests">+${entry.guests} con vos</p>` : ''}
      <p class="pass-code" aria-label="Código de ingreso">${esc(entry.pass)}</p>
    </div>
    <div class="pass-cut"></div>
    <dl class="pass-data">
      ${row('Fiesta', ev.name)}
      ${row('Cuándo', ev.date && fmtEventDate(ev.date))}
      ${row('Dónde', ev.address)}
    </dl>`;
}

function renderPasses(entries, status) {
  $('#pass').innerHTML = entries
    .map((entry, i) => `<div class="pass ${entry.checkedIn ? 'in' : ''}">${passHtml(entry, i === 0 ? status : null)}</div>`)
    .join('');
  show('passView');
}

async function loadStoredPasses() {
  const stored = store.get(PASSES_KEY) || [];
  const results = await Promise.all(stored.map((p) =>
    api(`/api/entries/${p.id}?t=${encodeURIComponent(p.token)}`).then((r) => r.entry).catch(() => null)));
  const valid = results.filter(Boolean);
  store.set(PASSES_KEY, stored.filter((p) => valid.some((e) => e.id === p.id)));
  return valid;
}

$('#addAnother').onclick = async () => {
  try {
    await openInside();
  } catch {
    show('gate');
  }
};

$('#forgetPass').onclick = () => {
  store.remove(PASSES_KEY);
  $('#addAnother').click();
};

// ---------- Inicio ----------

async function init() {
  try {
    const config = await api('/api/config');
    state.config = config;
    document.title = config.clubName;
    $$('[data-club-name]').forEach((el) => { el.textContent = config.clubName; });
    fitLogos();
    $('#gateLine1').textContent = config.gateLine1;
    $('#gateLine2').textContent = config.gateLine2;
    $('#footer').textContent = config.footer;
    $('#ageTag').textContent = config.minAge ? `+${config.minAge}` : '';
  } catch { /* se muestra igual */ }

  const passes = await loadStoredPasses();
  if (passes.length) return renderPasses(passes);
  try {
    await openInside();
  } catch {
    show('gate');
  }
}

init();
