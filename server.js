const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { data, save, nextId, normalizeCode } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || data.secret;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ACCESS_HOURS = 6;
const PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[aviso] Panel con contraseña por defecto (admin123). Cambiala con ADMIN_PASSWORD.');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilidades ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

// Límite de intentos por IP (para que el código no se pueda adivinar probando).
function rateLimiter(max, windowMinutes) {
  const hits = new Map();
  return {
    check(ip) {
      const now = Date.now();
      const entry = hits.get(ip);
      if (!entry || now > entry.reset) {
        hits.set(ip, { count: 1, reset: now + windowMinutes * 60 * 1000 });
        return;
      }
      entry.count += 1;
      if (entry.count > max) throw new HttpError(429, 'Muchos intentos seguidos. Esperá unos minutos.');
    },
    clear(ip) {
      hits.delete(ip);
    },
  };
}

const unlockLimiter = rateLimiter(8, 15);
const adminLimiter = rateLimiter(10, 15);

function passCode() {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((b) => PASS_ALPHABET[b % PASS_ALPHABET.length]).join('');
}

function publicEvent(event) {
  const taken = data.entries.filter((e) => e.eventId === event.id).length;
  return {
    id: event.id,
    name: event.name,
    date: event.date,
    description: event.description,
    listOpen: event.listOpen && (!event.capacity || taken < event.capacity),
    full: Boolean(event.capacity) && taken >= event.capacity,
  };
}

function passView(entry) {
  const event = data.events.find((e) => e.id === entry.eventId);
  return {
    id: entry.id,
    token: entry.token,
    pass: entry.pass,
    name: entry.name,
    guests: entry.guests,
    checkedIn: Boolean(entry.checkedInAt),
    event: event && { name: event.name, date: event.date, description: event.description, address: event.address },
  };
}

// ---------- Acceso con código ----------

function access(req) {
  const session = unsign(getCookie(req, 'pase'));
  if (!session) return null;
  const code = data.codes.find((c) => c.id === session.codeId && c.active);
  return code ? { code } : null;
}

function requireAccess(req, _res, next) {
  req.access = access(req);
  if (!req.access) throw new HttpError(401, 'Sin código no se pasa.');
  next();
}

app.get('/api/config', (_req, res) => {
  const { clubName, gateLine1, gateLine2, footer, instagram, minAge } = data.settings;
  res.json({ clubName, gateLine1, gateLine2, footer, instagram, minAge });
});

app.post('/api/unlock', (req, res) => {
  unlockLimiter.check(req.ip);
  const wanted = normalizeCode(req.body.code);
  const code = wanted && data.codes.find((c) => c.active && safeEqual(c.code, wanted));
  if (!code) throw new HttpError(401, 'No es ese. Preguntale a quien te lo pasó.');
  if (code.maxUses && code.uses >= code.maxUses) throw new HttpError(410, 'Ese código ya se usó todo lo que se podía.');
  code.uses += 1;
  save();
  unlockLimiter.clear(req.ip);
  setCookie(req, res, 'pase', sign({ codeId: code.id, exp: Date.now() + ACCESS_HOURS * 3600 * 1000 }), ACCESS_HOURS * 3600);
  res.json({ ok: true });
});

app.get('/api/events', requireAccess, (_req, res) => {
  const events = data.events
    .filter((e) => e.listOpen)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(publicEvent);
  res.json({ events, minAge: data.settings.minAge });
});

function ageOn(birthdate, when) {
  const [y, m, d] = birthdate.split('-').map(Number);
  const ref = new Date(when);
  let age = ref.getFullYear() - y;
  if (ref.getMonth() + 1 < m || (ref.getMonth() + 1 === m && ref.getDate() < d)) age -= 1;
  return age;
}

app.post('/api/entries', requireAccess, (req, res) => {
  const event = data.events.find((e) => e.id === num(req.body.eventId));
  if (!event || !publicEvent(event).listOpen) throw new HttpError(400, 'La lista de esta fecha ya cerró.');

  const name = str(req.body.name, 80);
  const dni = str(req.body.dni, 20).replace(/[.\s-]/g, '').toUpperCase();
  const birthdate = str(req.body.birthdate, 10);
  const instagram = str(req.body.instagram, 40).replace(/^@+/, '');
  const phone = str(req.body.phone, 30);
  const guests = Math.max(0, Math.min(3, Math.floor(num(req.body.guests)) || 0));

  if (name.split(/\s+/).length < 2) throw new HttpError(400, 'Necesitamos nombre y apellido, como figura en el DNI.');
  if (!/^[A-Z0-9]{6,12}$/.test(dni)) throw new HttpError(400, 'Revisá el DNI: solo números, sin puntos.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) throw new HttpError(400, 'Completá tu fecha de nacimiento.');
  if (ageOn(birthdate, event.date) < data.settings.minAge) {
    throw new HttpError(400, `Tenés que tener ${data.settings.minAge} años o más el día de la fiesta.`);
  }
  if (!phone) throw new HttpError(400, 'Falta el celular.');

  const existing = data.entries.find((e) => e.eventId === event.id && e.dni === dni);
  if (existing) return res.json({ entry: passView(existing), existing: true });

  const taken = data.entries.filter((e) => e.eventId === event.id).length;
  if (event.capacity && taken >= event.capacity) throw new HttpError(400, 'Se llenó la lista. Llegaste tarde esta vez.');

  let pass;
  do pass = passCode(); while (data.entries.some((e) => e.pass === pass));

  const entry = {
    id: nextId('entries'),
    token: crypto.randomBytes(12).toString('hex'),
    pass,
    eventId: event.id,
    codeId: req.access.code.id,
    name,
    dni,
    birthdate,
    instagram,
    phone,
    guests,
    checkedInAt: null,
    createdAt: new Date().toISOString(),
  };
  data.entries.push(entry);
  save();
  res.status(201).json({ entry: passView(entry) });
});

// Para volver a ver el pase (se guarda en el teléfono de quien se anotó).
app.get('/api/entries/:id', (req, res) => {
  const entry = data.entries.find((e) => e.id === num(req.params.id));
  if (!entry || !safeEqual(entry.token, String(req.query.t || ''))) throw new HttpError(404, 'No encontramos ese pase.');
  res.json({ entry: passView(entry) });
});

// ---------- Panel ----------

const ADMIN_HOURS = 12;

app.post('/api/admin/login', (req, res) => {
  adminLimiter.check(req.ip);
  if (!safeEqual(String(req.body.password || ''), ADMIN_PASSWORD)) throw new HttpError(401, 'Contraseña incorrecta.');
  adminLimiter.clear(req.ip);
  setCookie(req, res, 'admin', sign({ admin: true, exp: Date.now() + ADMIN_HOURS * 3600 * 1000 }), ADMIN_HOURS * 3600);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  setCookie(req, res, 'admin', '', 0);
  res.json({ ok: true });
});

const admin = express.Router();
admin.use((req, _res, next) => {
  if (!unsign(getCookie(req, 'admin'))?.admin) throw new HttpError(401, 'Iniciá sesión.');
  next();
});

admin.get('/me', (_req, res) => res.json({ ok: true }));

function eventStats(event) {
  const entries = data.entries.filter((e) => e.eventId === event.id);
  return {
    ...event,
    entries: entries.length,
    people: entries.reduce((n, e) => n + 1 + e.guests, 0),
    checkedIn: entries.filter((e) => e.checkedInAt).length,
  };
}

admin.get('/events', (_req, res) => {
  res.json({ events: [...data.events].sort((a, b) => b.date.localeCompare(a.date)).map(eventStats) });
});

function eventFromBody(body, existing = {}) {
  const name = str(body.name ?? existing.name, 80);
  const date = str(body.date ?? existing.date, 16);
  if (!name) throw new HttpError(400, 'La fiesta necesita un nombre.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)) throw new HttpError(400, 'Fecha y hora inválidas.');
  const capacity = Math.max(0, Math.floor(num(body.capacity ?? existing.capacity)) || 0);
  return {
    name,
    date,
    description: str(body.description ?? existing.description, 600),
    address: str(body.address ?? existing.address, 200),
    capacity,
    listOpen: body.listOpen === undefined ? existing.listOpen ?? true : Boolean(body.listOpen),
  };
}

admin.post('/events', (req, res) => {
  const event = { id: nextId('events'), ...eventFromBody(req.body), createdAt: new Date().toISOString() };
  data.events.push(event);
  save();
  res.status(201).json({ event: eventStats(event) });
});

admin.put('/events/:id', (req, res) => {
  const event = data.events.find((e) => e.id === num(req.params.id));
  if (!event) throw new HttpError(404, 'Fiesta no encontrada.');
  Object.assign(event, eventFromBody(req.body, event));
  save();
  res.json({ event: eventStats(event) });
});

admin.delete('/events/:id', (req, res) => {
  const id = num(req.params.id);
  const index = data.events.findIndex((e) => e.id === id);
  if (index === -1) throw new HttpError(404, 'Fiesta no encontrada.');
  data.events.splice(index, 1);
  data.entries = data.entries.filter((e) => e.eventId !== id);
  save();
  res.json({ ok: true });
});

function codeStats(code) {
  return { ...code, signups: data.entries.filter((e) => e.codeId === code.id).length };
}

admin.get('/codes', (_req, res) => res.json({ codes: data.codes.map(codeStats) }));

function codeFromBody(body, existing = {}) {
  const code = normalizeCode(body.code ?? existing.code);
  if (!/^[A-Z0-9ÑÁÉÍÓÚÜ_-]{3,30}$/.test(code)) throw new HttpError(400, 'El código tiene que tener entre 3 y 30 letras o números, sin espacios.');
  if (data.codes.some((c) => c.code === code && c.id !== existing.id)) throw new HttpError(409, 'Ya existe ese código.');
  return {
    code,
    label: str(body.label ?? existing.label, 60),
    maxUses: Math.max(0, Math.floor(num(body.maxUses ?? existing.maxUses)) || 0),
    active: body.active === undefined ? existing.active ?? true : Boolean(body.active),
  };
}

admin.post('/codes', (req, res) => {
  const code = { id: nextId('codes'), ...codeFromBody(req.body), uses: 0 };
  data.codes.push(code);
  save();
  res.status(201).json({ code: codeStats(code) });
});

admin.put('/codes/:id', (req, res) => {
  const code = data.codes.find((c) => c.id === num(req.params.id));
  if (!code) throw new HttpError(404, 'Código no encontrado.');
  Object.assign(code, codeFromBody(req.body, code));
  save();
  res.json({ code: codeStats(code) });
});

admin.delete('/codes/:id', (req, res) => {
  const index = data.codes.findIndex((c) => c.id === num(req.params.id));
  if (index === -1) throw new HttpError(404, 'Código no encontrado.');
  data.codes.splice(index, 1);
  save();
  res.json({ ok: true });
});

function entryView(e) {
  const code = data.codes.find((c) => c.id === e.codeId);
  const { token, ...rest } = e;
  return { ...rest, codeLabel: code ? code.label || code.code : '—' };
}

admin.get('/entries', (req, res) => {
  const eventId = num(req.query.eventId);
  const q = str(req.query.q, 60).toLowerCase();
  let entries = data.entries.filter((e) => e.eventId === eventId);
  if (q) {
    entries = entries.filter((e) => [e.name, e.dni, e.pass, e.instagram].some((f) => f.toLowerCase().includes(q)));
  }
  res.json({ entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'es')).map(entryView) });
});

admin.patch('/entries/:id', (req, res) => {
  const entry = data.entries.find((e) => e.id === num(req.params.id));
  if (!entry) throw new HttpError(404, 'No está en la lista.');
  entry.checkedInAt = req.body.checkedIn ? new Date().toISOString() : null;
  save();
  res.json({ entry: entryView(entry) });
});

admin.delete('/entries/:id', (req, res) => {
  const index = data.entries.findIndex((e) => e.id === num(req.params.id));
  if (index === -1) throw new HttpError(404, 'No está en la lista.');
  data.entries.splice(index, 1);
  save();
  res.json({ ok: true });
});

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita fórmulas al abrir en Excel
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

admin.get('/entries.csv', (req, res) => {
  const event = data.events.find((e) => e.id === num(req.query.eventId));
  if (!event) throw new HttpError(404, 'Fiesta no encontrada.');
  const rows = [['Nombre', 'DNI', 'Nacimiento', 'Instagram', 'Celular', 'Acompañantes', 'Código de ingreso', 'Vino por', 'Ingresó', 'Anotado']];
  for (const e of data.entries.filter((x) => x.eventId === event.id).map(entryView)) {
    rows.push([e.name, e.dni, e.birthdate, e.instagram && `@${e.instagram}`, e.phone, e.guests, e.pass, e.codeLabel, e.checkedInAt ? 'Sí' : 'No', e.createdAt]);
  }
  const filename = `lista-${event.date.slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n'));
});

admin.get('/settings', (_req, res) => res.json({ settings: data.settings }));

admin.put('/settings', (req, res) => {
  const s = data.settings;
  const b = req.body;
  if (b.clubName !== undefined) s.clubName = str(b.clubName, 40) || s.clubName;
  for (const key of ['gateLine1', 'gateLine2', 'footer']) if (b[key] !== undefined) s[key] = str(b[key], 140);
  if (b.instagram !== undefined) s.instagram = str(b.instagram, 40).replace(/^@+/, '');
  if (b.minAge !== undefined) s.minAge = Math.max(0, Math.min(99, Math.floor(num(b.minAge)) || 0));
  save();
  res.json({ settings: s });
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
  app.listen(PORT, () => console.log(`Funcionando en http://localhost:${PORT}`));
}

module.exports = app;
