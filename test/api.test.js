const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lista-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'clave-panel';
process.env.INITIAL_CODE = 'luna llena';

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

async function call(url, { method = 'GET', body, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no es JSON */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: json, text, cookie: setCookie && setCookie.split(';')[0] };
}

const person = (over = {}) => ({
  eventId: 1, name: 'Sofía Pérez', dni: '40.123.456', birthdate: '1998-05-10', phone: '11 5555 5555', instagram: '@sofi', guests: 1, ...over,
});

test('sin código no se ven las fiestas ni se puede anotar', async () => {
  assert.equal((await call('/api/events')).status, 401);
  assert.equal((await call('/api/entries', { method: 'POST', body: person() })).status, 401);
  const config = await call('/api/config');
  assert.equal(config.status, 200);
  assert.ok(!JSON.stringify(config.body).includes('LUNA'), 'el código nunca se envía al navegador');
});

test('código incorrecto se rechaza y hay límite de intentos', async () => {
  const wrong = await call('/api/unlock', { method: 'POST', body: { code: 'nope' }, ip: '10.0.0.9' });
  assert.equal(wrong.status, 401);
  let last;
  for (let i = 0; i < 9; i++) last = await call('/api/unlock', { method: 'POST', body: { code: 'nope' }, ip: '10.0.0.9' });
  assert.equal(last.status, 429);
});

test('con el código correcto te anotás y recibís tu pase con la dirección', async () => {
  const unlock = await call('/api/unlock', { method: 'POST', body: { code: ' Luna Llena ' }, ip: '10.0.0.1' });
  assert.equal(unlock.status, 200);
  const cookie = unlock.cookie;

  const events = await call('/api/events', { cookie });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].address, undefined, 'la dirección no se muestra antes de anotarse');

  const created = await call('/api/entries', { method: 'POST', cookie, body: person() });
  assert.equal(created.status, 201);
  assert.match(created.body.entry.pass, /^[A-Z2-9]{6}$/);
  assert.ok(created.body.entry.event.address);
  assert.equal(created.body.entry.guests, 1);

  const again = await call('/api/entries', { method: 'POST', cookie, body: person({ name: 'Otra Persona' }) });
  assert.equal(again.body.existing, true, 'el mismo DNI no se anota dos veces');
  assert.equal(again.body.entry.pass, created.body.entry.pass);

  const view = await call(`/api/entries/${created.body.entry.id}?t=${created.body.entry.token}`);
  assert.equal(view.status, 200);
  assert.equal((await call(`/api/entries/${created.body.entry.id}?t=malo`)).status, 404);
});

test('valida edad y datos', async () => {
  const { cookie } = await call('/api/unlock', { method: 'POST', body: { code: 'LUNALLENA' }, ip: '10.0.0.2' });
  const young = await call('/api/entries', { method: 'POST', cookie, body: person({ dni: '50111222', birthdate: '2015-01-01' }) });
  assert.equal(young.status, 400);
  const noSurname = await call('/api/entries', { method: 'POST', cookie, body: person({ dni: '50111223', name: 'Sofía' }) });
  assert.equal(noSurname.status, 400);
});

test('el panel pide contraseña y administra fiestas, códigos y la lista', async () => {
  assert.equal((await call('/api/admin/events')).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'mal' }, ip: '10.0.0.3' })).status, 401);
  const { cookie } = await call('/api/admin/login', { method: 'POST', body: { password: 'clave-panel' }, ip: '10.0.0.3' });

  const code = await call('/api/admin/codes', { method: 'POST', cookie, body: { code: 'rrpp-juli', label: 'Juli', maxUses: 1 } });
  assert.equal(code.status, 201);
  assert.equal(code.body.code.code, 'RRPP-JULI');

  const guest = await call('/api/unlock', { method: 'POST', body: { code: 'rrpp-juli' }, ip: '10.0.0.4' });
  assert.equal(guest.status, 200);
  await call('/api/entries', { method: 'POST', cookie: guest.cookie, body: person({ dni: '33444555', name: 'Juan Gómez' }) });
  const used = await call('/api/unlock', { method: 'POST', body: { code: 'rrpp-juli' }, ip: '10.0.0.5' });
  assert.equal(used.status, 410, 'el código con un solo uso ya no sirve');

  const codes = await call('/api/admin/codes', { cookie });
  assert.equal(codes.body.codes.find((c) => c.code === 'RRPP-JULI').signups, 1);

  const list = await call('/api/admin/entries?eventId=1', { cookie });
  assert.equal(list.body.entries.length, 2);
  const juan = list.body.entries.find((e) => e.name === 'Juan Gómez');
  assert.equal(juan.codeLabel, 'Juli');

  const search = await call(`/api/admin/entries?eventId=1&q=${juan.pass.toLowerCase()}`, { cookie });
  assert.equal(search.body.entries.length, 1);

  const checked = await call(`/api/admin/entries/${juan.id}`, { method: 'PATCH', cookie, body: { checkedIn: true } });
  assert.ok(checked.body.entry.checkedInAt);

  const csv = await call('/api/admin/entries.csv?eventId=1', { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Juan Gómez/);

  const closed = await call('/api/admin/events/1', { method: 'PUT', cookie, body: { listOpen: false } });
  assert.equal(closed.body.event.listOpen, false);
  const { cookie: c2 } = await call('/api/unlock', { method: 'POST', body: { code: 'lunallena' }, ip: '10.0.0.6' });
  assert.equal((await call('/api/events', { cookie: c2 })).body.events.length, 0);

  // Pausar el código general corta el acceso de quien entró con él.
  const general = codes.body.codes.find((c) => c.code === 'LUNALLENA');
  await call(`/api/admin/codes/${general.id}`, { method: 'PUT', cookie, body: { active: false } });
  assert.equal((await call('/api/events', { cookie: c2 })).status, 401);
});
