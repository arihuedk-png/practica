const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tienda-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'secreto123';
process.env.WHATSAPP_NUMBER = '5215512345678';

const app = require('../server');
let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(url, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, cookie: setCookie && setCookie.split(';')[0] };
}

test('el catálogo trae categorías y productos activos', async () => {
  const { status, body } = await call('/api/catalog');
  assert.equal(status, 200);
  assert.ok(body.categories.length > 0);
  assert.ok(body.products.every((p) => p.active));
});

test('crear pedido recalcula precios en el servidor y genera link de WhatsApp', async () => {
  const { body: catalog } = await call('/api/catalog');
  const product = catalog.products[0];
  const { status, body } = await call('/api/orders', {
    method: 'POST',
    body: {
      items: [{ productId: product.id, qty: 2, note: 'sin sal', price: 0.01 }],
      customer: { name: 'Ana', phone: '555 123', address: 'Calle 1' },
      delivery: 'envio',
      payment: 'efectivo',
    },
  });
  assert.equal(status, 201);
  assert.equal(body.order.subtotal, product.price * 2);
  assert.equal(body.order.total, product.price * 2 + body.order.deliveryFee);
  assert.match(body.order.whatsappUrl, /^https:\/\/wa\.me\/5215512345678\?text=/);
  assert.equal(body.order.token, undefined);

  const tracked = await call(body.order.trackingUrl.replace('/pedido.html?id=', '/api/orders/').replace('&t=', '?t='));
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.order.id, body.order.id);

  const wrongToken = await call(`/api/orders/${body.order.id}?t=malo`);
  assert.equal(wrongToken.status, 404);
});

test('rechaza pedidos inválidos', async () => {
  const empty = await call('/api/orders', { method: 'POST', body: { items: [], customer: { name: 'A', phone: '1' } } });
  assert.equal(empty.status, 400);
  const noAddress = await call('/api/orders', {
    method: 'POST',
    body: { items: [{ productId: 1, qty: 1 }], customer: { name: 'A', phone: '1' }, delivery: 'envio' },
  });
  assert.equal(noAddress.status, 400);
  const mp = await call('/api/orders', {
    method: 'POST',
    body: { items: [{ productId: 1, qty: 1 }], customer: { name: 'A', phone: '1' }, delivery: 'retiro', payment: 'mercadopago' },
  });
  assert.equal(mp.status, 400);
});

test('registro, login y mis pedidos', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'Luis', email: 'luis@test.com', password: '123456' } });
  assert.equal(reg.status, 201);
  assert.ok(reg.cookie);

  const dup = await call('/api/auth/register', { method: 'POST', body: { name: 'Luis', email: 'luis@test.com', password: '123456' } });
  assert.equal(dup.status, 409);

  await call('/api/orders', {
    method: 'POST',
    cookie: reg.cookie,
    body: { items: [{ productId: 1, qty: 1 }], customer: { name: 'Luis', phone: '1' }, delivery: 'retiro' },
  });
  const mine = await call('/api/orders/mine', { cookie: reg.cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.orders.length, 1);

  const bad = await call('/api/auth/login', { method: 'POST', body: { email: 'luis@test.com', password: 'mal' } });
  assert.equal(bad.status, 401);

  const forbidden = await call('/api/admin/orders', { cookie: reg.cookie });
  assert.equal(forbidden.status, 403);
});

test('el admin gestiona productos, pedidos y ajustes', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@test.com', password: 'secreto123' } });
  assert.equal(login.status, 200);
  const cookie = login.cookie;

  const created = await call('/api/admin/products', { method: 'POST', cookie, body: { name: 'Nuevo', price: 99, categoryId: 1 } });
  assert.equal(created.status, 201);
  const updated = await call(`/api/admin/products/${created.body.product.id}`, { method: 'PUT', cookie, body: { price: 80, active: false } });
  assert.equal(updated.body.product.price, 80);
  const catalog = await call('/api/catalog');
  assert.ok(!catalog.body.products.some((p) => p.id === created.body.product.id));

  const orders = await call('/api/admin/orders', { cookie });
  const patched = await call(`/api/admin/orders/${orders.body.orders[0].id}`, { method: 'PATCH', cookie, body: { status: 'preparando', paymentStatus: 'pagado' } });
  assert.equal(patched.body.order.status, 'preparando');
  assert.equal(patched.body.order.paymentStatus, 'pagado');

  const closed = await call('/api/admin/settings', { method: 'PUT', cookie, body: { isOpen: false, storeName: 'Prueba' } });
  assert.equal(closed.body.settings.storeName, 'Prueba');
  const rejected = await call('/api/orders', {
    method: 'POST',
    body: { items: [{ productId: 1, qty: 1 }], customer: { name: 'A', phone: '1' }, delivery: 'retiro' },
  });
  assert.equal(rejected.status, 400);
  await call('/api/admin/settings', { method: 'PUT', cookie, body: { isOpen: true } });

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const upload = await call('/api/admin/upload', { method: 'POST', cookie, body: { dataUrl: png } });
  assert.equal(upload.status, 201);
  const img = await fetch(base + upload.body.url);
  assert.equal(img.status, 200);

  const badUpload = await call('/api/admin/upload', { method: 'POST', cookie, body: { dataUrl: 'data:text/html;base64,PGgxPg==' } });
  assert.equal(badUpload.status, 400);
});

test('una cookie de sesión manipulada no da acceso', async () => {
  const res = await call('/api/auth/me', { cookie: 'sid=eyJ1aWQiOjF9.firmafalsa' });
  assert.equal(res.body.user, null);
});
