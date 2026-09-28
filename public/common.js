// Utilidades compartidas por la tienda, el seguimiento y el panel admin.
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Ocurrió un error');
  return body;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(value) {
  return '$' + Number(value || 0).toLocaleString('es', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
}

const STATUS_LABELS = {
  pendiente: 'Pendiente',
  confirmado: 'Confirmado',
  preparando: 'En preparación',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

const PAYMENT_LABELS = { efectivo: 'Efectivo', transferencia: 'Transferencia', mercadopago: 'Mercado Pago' };

function toast(message, type = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Imagen de reemplazo cuando un producto no tiene foto.
function placeholderImage(name) {
  const hue = [...String(name)].reduce((h, c) => (h + c.charCodeAt(0)) % 360, 0);
  const letter = esc(String(name).trim().charAt(0).toUpperCase() || '?');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="hsl(${hue},60%,88%)"/><text x="200" y="190" font-family="sans-serif" font-size="140" font-weight="700" text-anchor="middle" fill="hsl(${hue},45%,45%)">${letter}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function applyTheme(color) {
  if (color) document.documentElement.style.setProperty('--brand', color);
}
