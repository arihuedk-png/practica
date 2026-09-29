// Almacenamiento simple en un archivo JSON.
// Las escrituras son síncronas (archivo temporal + rename) para que nunca
// queden a medias; alcanza de sobra para un solo proceso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/\s+/g, '');
}

function nextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return `${d.toISOString().slice(0, 10)}T23:30`;
}

function seed() {
  const code = normalizeCode(process.env.INITIAL_CODE || 'MEDIANOCHE');
  return {
    settings: {
      clubName: process.env.CLUB_NAME || 'medianoche',
      gateLine1: 'No hay flyers ni publicidad. El código se pasa de boca en boca.',
      gateLine2: 'Si lo tenés, ya sabés qué hacer.',
      footer: 'Derecho de admisión reservado',
      instagram: '',
      minAge: 18,
    },
    events: [{
      id: 1,
      name: 'Noche de apertura',
      date: nextFriday(),
      description: 'Todo negro. Lista hasta la 1:30; después, depende de la puerta.',
      address: 'Dirección a confirmar',
      capacity: 200,
      listOpen: true,
      createdAt: new Date().toISOString(),
    }],
    codes: [{ id: 1, code, label: 'Código general', maxUses: 0, uses: 0, active: true }],
    entries: [],
    counters: { events: 1, codes: 1, entries: 0 },
    secret: crypto.randomBytes(32).toString('hex'),
  };
}

let data;
if (fs.existsSync(DB_FILE)) {
  data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} else {
  data = seed();
  save();
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nextId(collection) {
  data.counters[collection] = (data.counters[collection] || 0) + 1;
  return data.counters[collection];
}

module.exports = { data, save, nextId, normalizeCode };
