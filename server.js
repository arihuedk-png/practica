const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { data, save, nextId, hashPassword, verifyPassword, UPLOADS_DIR } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || data.secret;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const SESSION_DAYS = 30;

const ORDER_STATUSES = ['pendiente', 'confirmado', 'preparando', 'en_camino', 'entregado', 'cancelado'];
const PAYMENT_METHODS = ['efectivo', 'transferencia', 'mercadopago'];

app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// ---------- Utilidades ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const money = (v) => Math.round(v * 100) / 100;

function publicUser(u) {
  return u && { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
}

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// ---------- Sesiones (cookie firmada con HMAC) ----------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSession(req, res, user) {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const token = sign({ uid: user.id, exp: Date.now() + maxAge * 1000 });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

app.use((req, _res, next) => {
  const session = unsign(getCookie(req, 'sid'));
  req.user = session ? data.users.find((u) => u.id === session.uid) || null : null;
  next();
});

function requireUser(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'Debes iniciar sesión');
  next();
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') throw new HttpError(403, 'Solo para administradores');
  next();
}

// Límite simple de intentos de login por IP.
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
  entry.count += 1;
  loginAttempts.set(ip, entry);
  if (entry.count > 10) throw new HttpError(429, 'Demasiados intentos. Intenta de nuevo en unos minutos.');
}

// ---------- API pública ----------

app.get('/api/config', (_req, res) => {
  const { transferInfo, ...rest } = data.settings;
  res.json({ ...rest, transferInfo, mercadoPago: Boolean(MP_TOKEN) });
});

app.get('/api/catalog', (_req, res) => {
  const categories = [...data.categories].sort((a, b) => a.order - b.order);
  const products = data.products.filter((p) => p.active);
  res.json({ categories, products });
});

// ---------- Autenticación ----------

app.post('/api/auth/register', (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 120).toLowerCase();
  const phone = str(req.body.phone, 30);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Nombre y email válidos son obligatorios');
  if (password.length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
  if (data.users.some((u) => u.email === email)) throw new HttpError(409, 'Ya existe una cuenta con ese email');

  const user = { id: nextId('users'), name, email, phone, role: 'cliente', ...hashPassword(password), createdAt: new Date().toISOString() };
  data.users.push(user);
  save();
  setSession(req, res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  checkLoginRate(req.ip);
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = data.users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user)) throw new HttpError(401, 'Email o contraseña incorrectos');
  loginAttempts.delete(req.ip);
  setSession(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------- Pedidos ----------

function whatsappLink(order, req) {
  const s = data.settings;
  if (!s.whatsapp) return null;
  const fmt = (v) => `$${v.toLocaleString('es', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const lines = [
    `*Nuevo pedido #${order.id}* - ${s.storeName}`,
    '',
    ...order.items.map((i) => `• ${i.qty} x ${i.name} — ${fmt(i.price * i.qty)}${i.note ? `\n   _${i.note}_` : ''}`),
    '',
    `Subtotal: ${fmt(order.subtotal)}`,
    order.deliveryFee ? `Envío: ${fmt(order.deliveryFee)}` : null,
    `*Total: ${fmt(order.total)}*`,
    '',
    `Nombre: ${order.customer.name}`,
    `Teléfono: ${order.customer.phone}`,
    order.delivery === 'envio' ? `Entrega a domicilio: ${order.customer.address}` : 'Retiro en el local',
    `Pago: ${order.payment}`,
    order.notes ? `Notas: ${order.notes}` : null,
    '',
    `Seguimiento: ${baseUrl(req)}/pedido.html?id=${order.id}&t=${order.token}`,
  ].filter((l) => l !== null);
  const phone = s.whatsapp.replace(/\D/g, '');
  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`;
}

function orderView(order, req) {
  const { token, ...rest } = order;
  return { ...rest, trackingUrl: `/pedido.html?id=${order.id}&t=${token}`, whatsappUrl: whatsappLink(order, req) };
}

async function createMercadoPagoPreference(order, req) {
  const base = baseUrl(req);
  const back = `${base}/pedido.html?id=${order.id}&t=${order.token}`;
  const items = order.items.map((i) => ({
    title: i.name,
    quantity: i.qty,
    unit_price: i.price,
    currency_id: data.settings.currency,
  }));
  if (order.deliveryFee) {
    items.push({ title: 'Envío', quantity: 1, unit_price: order.deliveryFee, currency_id: data.settings.currency });
  }
  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      external_reference: String(order.id),
      back_urls: { success: back, failure: back, pending: back },
      auto_return: 'approved',
      notification_url: `${base}/api/payments/webhook`,
    }),
  });
  if (!response.ok) {
    console.error('Mercado Pago error', response.status, await response.text());
    return null;
  }
  const pref = await response.json();
  return pref.init_point;
}

app.post('/api/orders', async (req, res) => {
  const s = data.settings;
  if (!s.isOpen) throw new HttpError(400, 'La tienda está cerrada en este momento');

  const rawItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const items = [];
  for (const raw of rawItems) {
    const product = data.products.find((p) => p.id === num(raw.productId) && p.active);
    const qty = Math.floor(num(raw.qty));
    if (!product) throw new HttpError(400, 'Un producto del carrito ya no está disponible');
    if (!(qty >= 1 && qty <= 99)) throw new HttpError(400, 'Cantidad inválida');
    items.push({ productId: product.id, name: product.name, price: product.price, qty, note: str(raw.note, 200) });
  }
  if (!items.length) throw new HttpError(400, 'El carrito está vacío');

  const customer = {
    name: str(req.body.customer?.name, 80),
    phone: str(req.body.customer?.phone, 30),
    address: str(req.body.customer?.address, 200),
  };
  const delivery = req.body.delivery === 'envio' ? 'envio' : 'retiro';
  const payment = PAYMENT_METHODS.includes(req.body.payment) ? req.body.payment : 'efectivo';
  if (!customer.name || !customer.phone) throw new HttpError(400, 'Nombre y teléfono son obligatorios');
  if (delivery === 'envio' && !customer.address) throw new HttpError(400, 'Indica la dirección de entrega');
  if (payment === 'mercadopago' && !MP_TOKEN) throw new HttpError(400, 'El pago en línea no está disponible');

  const subtotal = money(items.reduce((sum, i) => sum + i.price * i.qty, 0));
  if (s.minOrder && subtotal < s.minOrder) throw new HttpError(400, `El pedido mínimo es de $${s.minOrder}`);
  const deliveryFee = delivery === 'envio' ? money(s.deliveryFee || 0) : 0;

  const order = {
    id: nextId('orders'),
    token: crypto.randomBytes(12).toString('hex'),
    userId: req.user?.id || null,
    items,
    customer,
    delivery,
    payment,
    paymentStatus: 'pendiente',
    notes: str(req.body.notes, 300),
    subtotal,
    deliveryFee,
    total: money(subtotal + deliveryFee),
    status: 'pendiente',
    createdAt: new Date().toISOString(),
  };
  data.orders.push(order);
  save();

  let paymentUrl = null;
  if (payment === 'mercadopago') {
    paymentUrl = await createMercadoPagoPreference(order, req);
  }
  res.status(201).json({ order: orderView(order, req), paymentUrl });
});

app.get('/api/orders/mine', requireUser, (req, res) => {
  const orders = data.orders.filter((o) => o.userId === req.user.id).reverse().map((o) => orderView(o, req));
  res.json({ orders });
});

app.get('/api/orders/:id', (req, res) => {
  const order = data.orders.find((o) => o.id === num(req.params.id));
  const token = String(req.query.t || '');
  const allowed = order && (
    (token.length === order.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(order.token)))
    || (req.user && (req.user.role === 'admin' || req.user.id === order.userId))
  );
  if (!allowed) throw new HttpError(404, 'Pedido no encontrado');
  res.json({ order: orderView(order, req) });
});

// Notificaciones de Mercado Pago: se consulta el pago en su API para confirmarlo.
app.post('/api/payments/webhook', async (req, res) => {
  res.sendStatus(200);
  const type = req.body?.type || req.query.type || req.query.topic;
  const paymentId = req.body?.data?.id || req.query['data.id'] || req.query.id;
  if (!MP_TOKEN || type !== 'payment' || !paymentId) return;
  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!r.ok) return;
    const payment = await r.json();
    const order = data.orders.find((o) => String(o.id) === String(payment.external_reference));
    if (!order) return;
    order.paymentStatus = payment.status === 'approved' ? 'pagado' : payment.status;
    order.paymentId = String(payment.id);
    if (order.paymentStatus === 'pagado' && order.status === 'pendiente') order.status = 'confirmado';
    save();
  } catch (err) {
    console.error('Error procesando webhook de Mercado Pago', err);
  }
});

// ---------- Administración ----------

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/stats', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todays = data.orders.filter((o) => o.createdAt.startsWith(today) && o.status !== 'cancelado');
  res.json({
    ordersToday: todays.length,
    salesToday: money(todays.reduce((s, o) => s + o.total, 0)),
    pending: data.orders.filter((o) => o.status === 'pendiente').length,
    products: data.products.length,
    customers: data.users.filter((u) => u.role === 'cliente').length,
  });
});

admin.get('/orders', (req, res) => {
  let orders = [...data.orders].reverse();
  if (req.query.status) orders = orders.filter((o) => o.status === req.query.status);
  res.json({ orders: orders.slice(0, 200).map((o) => orderView(o, req)), statuses: ORDER_STATUSES });
});

admin.patch('/orders/:id', (req, res) => {
  const order = data.orders.find((o) => o.id === num(req.params.id));
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  if (req.body.status !== undefined) {
    if (!ORDER_STATUSES.includes(req.body.status)) throw new HttpError(400, 'Estado inválido');
    order.status = req.body.status;
  }
  if (req.body.paymentStatus !== undefined) {
    order.paymentStatus = req.body.paymentStatus === 'pagado' ? 'pagado' : 'pendiente';
  }
  save();
  res.json({ order: orderView(order, req) });
});

function productFromBody(body, existing = {}) {
  const name = str(body.name ?? existing.name, 100);
  const price = num(body.price ?? existing.price);
  const categoryId = num(body.categoryId ?? existing.categoryId);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  if (!(price >= 0)) throw new HttpError(400, 'Precio inválido');
  if (!data.categories.some((c) => c.id === categoryId)) throw new HttpError(400, 'Categoría inválida');
  return {
    name,
    description: str(body.description ?? existing.description, 500),
    price: money(price),
    categoryId,
    image: str(body.image ?? existing.image, 300),
    active: body.active === undefined ? existing.active ?? true : Boolean(body.active),
    featured: body.featured === undefined ? existing.featured ?? false : Boolean(body.featured),
  };
}

admin.get('/products', (_req, res) => res.json({ products: data.products }));

admin.post('/products', (req, res) => {
  const product = { id: nextId('products'), ...productFromBody(req.body), createdAt: new Date().toISOString() };
  data.products.push(product);
  save();
  res.status(201).json({ product });
});

admin.put('/products/:id', (req, res) => {
  const product = data.products.find((p) => p.id === num(req.params.id));
  if (!product) throw new HttpError(404, 'Producto no encontrado');
  Object.assign(product, productFromBody(req.body, product));
  save();
  res.json({ product });
});

admin.delete('/products/:id', (req, res) => {
  const index = data.products.findIndex((p) => p.id === num(req.params.id));
  if (index === -1) throw new HttpError(404, 'Producto no encontrado');
  data.products.splice(index, 1);
  save();
  res.json({ ok: true });
});

admin.post('/categories', (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const category = { id: nextId('categories'), name, order: num(req.body.order) || data.categories.length + 1 };
  data.categories.push(category);
  save();
  res.status(201).json({ category });
});

admin.put('/categories/:id', (req, res) => {
  const category = data.categories.find((c) => c.id === num(req.params.id));
  if (!category) throw new HttpError(404, 'Categoría no encontrada');
  if (req.body.name !== undefined) category.name = str(req.body.name, 60) || category.name;
  if (req.body.order !== undefined && Number.isFinite(num(req.body.order))) category.order = num(req.body.order);
  save();
  res.json({ category });
});

admin.delete('/categories/:id', (req, res) => {
  const id = num(req.params.id);
  if (data.products.some((p) => p.categoryId === id)) throw new HttpError(400, 'La categoría tiene productos; muévelos o bórralos primero');
  const index = data.categories.findIndex((c) => c.id === id);
  if (index === -1) throw new HttpError(404, 'Categoría no encontrada');
  data.categories.splice(index, 1);
  save();
  res.json({ ok: true });
});

admin.get('/settings', (_req, res) => res.json({ settings: data.settings }));

admin.put('/settings', (req, res) => {
  const s = data.settings;
  const b = req.body;
  if (b.storeName !== undefined) s.storeName = str(b.storeName, 60) || s.storeName;
  if (b.tagline !== undefined) s.tagline = str(b.tagline, 120);
  if (b.whatsapp !== undefined) s.whatsapp = str(b.whatsapp, 30);
  if (b.currency !== undefined) s.currency = str(b.currency, 3).toUpperCase() || s.currency;
  if (b.deliveryFee !== undefined) s.deliveryFee = Math.max(0, num(b.deliveryFee) || 0);
  if (b.minOrder !== undefined) s.minOrder = Math.max(0, num(b.minOrder) || 0);
  if (b.isOpen !== undefined) s.isOpen = Boolean(b.isOpen);
  if (b.hours !== undefined) s.hours = str(b.hours, 120);
  if (b.address !== undefined) s.address = str(b.address, 200);
  if (b.transferInfo !== undefined) s.transferInfo = str(b.transferInfo, 300);
  if (b.primaryColor !== undefined && /^#[0-9a-f]{6}$/i.test(b.primaryColor)) s.primaryColor = b.primaryColor;
  save();
  res.json({ settings: s });
});

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

admin.post('/upload', (req, res) => {
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(req.body.dataUrl || ''));
  const ext = match && IMAGE_TYPES[match[1]];
  if (!ext) throw new HttpError(400, 'Formato de imagen no soportado (usa PNG, JPG, WEBP o GIF)');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw new HttpError(400, 'La imagen no puede superar 4 MB');
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  res.status(201).json({ url: `/uploads/${filename}` });
});

app.use('/api/admin', admin);

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Errores ----------

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada')));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Tienda funcionando en http://localhost:${PORT}`));
}

module.exports = app;
