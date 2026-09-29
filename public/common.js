// Utilidades compartidas por la puerta y el panel.
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Algo salió mal. Probá de nuevo.');
    err.status = res.status;
    err.campos = body.campos || null; // errores por campo del formulario
    err.motivo = body.motivo || null; // "acceso" o "registro": qué pantalla falta
    throw err;
  }
  return body;
}

// Pesos argentinos sin centavos: 15000 → "$15.000".
function fmtPesos(n) {
  return `$${Number(n || 0).toLocaleString('es-AR')}`;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Las fechas se guardan como "2026-10-03T00:30" (hora local del boliche).
function parseLocal(value) {
  const [d, t = '00:00'] = String(value).split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  return new Date(y, m - 1, day, h, min);
}

function fmtEventDate(value) {
  const date = parseLocal(value);
  const day = date.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const time = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time} h`;
}

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ }
  },
};

// Achica el logo lo justo para que el nombre entre en una línea.
function fitLogos() {
  for (const el of $$('.logo')) {
    if (!el.offsetParent) continue; // oculto
    el.style.fontSize = '';
    const width = el.clientWidth;
    if (el.scrollWidth > width) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = `${Math.floor(size * (width / el.scrollWidth) * 0.98)}px`;
    }
  }
}
window.addEventListener('resize', fitLogos);
document.fonts?.ready.then(fitLogos);
