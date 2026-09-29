const PASSES_KEY = 'pases';
const state = { events: [], minAge: 18, config: {} };

function show(id) {
  for (const section of ['gate', 'inside', 'passView']) $(`#${section}`).hidden = section !== id;
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

// ---------- Adentro ----------

function eventHtml(ev) {
  return `
    <p class="event-date">${esc(fmtEventDate(ev.date))}</p>
    <h2 class="event-name">${esc(ev.name)}</h2>
    ${ev.description ? `<p class="event-desc">${esc(ev.description)}</p>` : ''}`;
}

function renderEvents() {
  const open = state.events.filter((ev) => ev.listOpen);
  const form = $('#listForm');
  if (!open.length) {
    const full = state.events.some((ev) => ev.full);
    const ig = state.config.instagram;
    $('#eventBox').innerHTML = `
      <div class="event">
        <h2 class="event-name">${full ? 'La lista se llenó' : 'No hay fechas abiertas'}</h2>
        <p class="event-desc">${ig ? `Las próximas fechas se anuncian en <a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">@${esc(ig)}</a>.` : 'Volvé a pasar en unos días.'}</p>
      </div>`;
    form.hidden = true;
    return;
  }
  form.hidden = false;
  if (open.length === 1) {
    $('#eventBox').innerHTML = `<div class="event">${eventHtml(open[0])}</div>`;
    $('#eventPicker').hidden = true;
    $('#eventPicker').innerHTML = `<input type="radio" name="eventId" value="${open[0].id}" checked>`;
  } else {
    $('#eventBox').innerHTML = '<div class="event"><h2 class="event-name">Elegí la fecha</h2></div>';
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
    $('#listMessage').textContent = 'Completá todos los datos.';
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
    renderPasses([entry], existing ? 'Ya estabas en lista' : null);
  } catch (err) {
    if (err.status === 401) {
      show('gate');
      $('#codeMessage').textContent = 'Tu acceso venció. Volvé a ingresar el código.';
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
  return `
    <p class="pass-status">${esc(status || (entry.checkedIn ? 'Ya ingresaste' : 'Estás en lista'))}</p>
    <p class="pass-name">${esc(entry.name)}</p>
    ${entry.guests ? `<p class="pass-guests">+${entry.guests} acompañante${entry.guests > 1 ? 's' : ''}</p>` : ''}
    <p class="pass-code" aria-label="Código de ingreso">${esc(entry.pass)}</p>
    <hr class="pass-divider">
    ${ev.name ? `<p class="pass-detail"><b>${esc(ev.name)}</b></p>` : ''}
    ${ev.date ? `<p class="pass-detail">${esc(fmtEventDate(ev.date))}</p>` : ''}
    ${ev.address ? `<p class="pass-detail">${esc(ev.address)}</p>` : ''}
    <p class="pass-hint">Mostrá este código y tu DNI en la puerta.</p>`;
}

function renderPasses(entries, status) {
  $('#pass').outerHTML = `<div id="pass" class="column">${entries.map((entry, i) => `<div class="pass">${passHtml(entry, i === 0 ? status : null)}</div>`).join('')}</div>`;
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
    $('#gateLine1').textContent = config.gateLine1;
    $('#gateLine2').textContent = config.gateLine2;
    $('#footer').textContent = config.footer;
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
