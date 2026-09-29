// Base de datos SQLite (viene incluida en Node 22.13 o superior): un solo archivo dentro de DATA_DIR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Validar = require('./public/validar');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(`Esta página necesita Node.js 22.13 o superior (tenés ${process.version}). Descargalo de https://nodejs.org`);
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'productora.db'));
// WAL + synchronous NORMAL: la configuración recomendada por SQLite para servidores; mucho más rápida
// y la base nunca queda corrupta (ante un corte de luz, como mucho se pierde el último segundo).
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const AHORA = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

db.exec(`
  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    fecha TEXT NOT NULL,                  -- "2026-10-03T23:30", hora local del lugar
    descripcion TEXT NOT NULL DEFAULT '',
    direccion TEXT NOT NULL DEFAULT '',   -- solo la ve quien tiene un pedido pagado
    cupo INTEGER NOT NULL DEFAULT 0,      -- máximo de registros; 0 = sin límite
    abierto INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL DEFAULT ${AHORA}
  );

  CREATE TABLE IF NOT EXISTS rrpp (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL DEFAULT ${AHORA}
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    instagram TEXT NOT NULL,
    cumpleanos TEXT NOT NULL,             -- "AAAA-MM-DD"
    telefono TEXT NOT NULL UNIQUE,        -- con código de país: "+5491112345678"
    rrpp_id INTEGER REFERENCES rrpp(id),  -- el primer RRPP que lo trajo
    evento_id INTEGER REFERENCES eventos(id) ON DELETE SET NULL,  -- fecha en la que se registró
    consentimiento_en TEXT NOT NULL,      -- cuándo aceptó el uso de sus datos
    creado_en TEXT NOT NULL DEFAULT ${AHORA}
  );

  CREATE TABLE IF NOT EXISTS lista_rrpp (
    id INTEGER PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    rrpp_id INTEGER REFERENCES rrpp(id),  -- NULL = entró sin RRPP
    evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    creado_en TEXT NOT NULL DEFAULT ${AHORA},
    UNIQUE (cliente_id, evento_id)
  );

  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    precio INTEGER NOT NULL,              -- pesos, sin el recargo
    activo INTEGER NOT NULL DEFAULT 1,
    orden INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL DEFAULT ${AHORA}
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,          -- lo ve el cliente y se muestra en la puerta
    token TEXT NOT NULL,                  -- secreto para ver el pedido desde el teléfono
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    rrpp_id INTEGER REFERENCES rrpp(id),
    evento_id INTEGER NOT NULL REFERENCES eventos(id),
    estado TEXT NOT NULL DEFAULT 'pendiente'
      CHECK (estado IN ('pendiente', 'aprobado', 'rechazado', 'pagado')),
    total INTEGER NOT NULL,
    mp_link TEXT,
    mp_pago_id TEXT,
    creado_en TEXT NOT NULL DEFAULT ${AHORA},
    decidido_en TEXT,
    pagado_en TEXT,
    ingreso_en TEXT
  );

  CREATE TABLE IF NOT EXISTS pedido_items (
    id INTEGER PRIMARY KEY,
    pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,                 -- copia del producto al momento de pedir
    precio INTEGER NOT NULL,
    recargo INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    subtotal INTEGER NOT NULL             -- (precio + recargo) × cantidad
  );

  CREATE INDEX IF NOT EXISTS lista_rrpp_evento ON lista_rrpp (evento_id);
  CREATE INDEX IF NOT EXISTS lista_rrpp_rrpp ON lista_rrpp (rrpp_id);
  CREATE INDEX IF NOT EXISTS pedidos_estado ON pedidos (estado);
  CREATE INDEX IF NOT EXISTS pedidos_cliente ON pedidos (cliente_id);
  CREATE INDEX IF NOT EXISTS pedido_items_pedido ON pedido_items (pedido_id);
`);

// ---------- Consultas ----------

const preparadas = new Map();
function sentencia(sql) {
  let s = preparadas.get(sql);
  if (!s) {
    s = db.prepare(sql);
    preparadas.set(sql, s);
  }
  return s;
}

const all = (sql, ...params) => sentencia(sql).all(...params);
const get = (sql, ...params) => sentencia(sql).get(...params);
const run = (sql, ...params) => sentencia(sql).run(...params);

// Ejecuta varias escrituras juntas: o se guardan todas o ninguna.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Configuración ----------

const CONSENTIMIENTO = `Al registrarte aceptás que {lugar} guarde tu nombre y apellido, tu usuario de Instagram, tu fecha de cumpleaños y tu teléfono.

Los usamos para gestionar tu registro, tus pedidos y tu ingreso, para saber qué RRPP te invitó y para avisarte de próximas fechas y promociones (por ejemplo, en tu cumpleaños). No vendemos ni compartimos tus datos con terceros.

Podés pedir ver, corregir o borrar tus datos cuando quieras escribiéndonos por Instagram o WhatsApp. El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses, salvo que se acredite un interés legítimo al efecto conforme lo establecido en el artículo 14, inciso 3 de la Ley N° 25.326. La Agencia de Acceso a la Información Pública, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.`;

const POR_DEFECTO = {
  nombre_lugar: process.env.CLUB_NAME || 'medianoche',
  texto_puerta_1: 'No hay flyers ni publicidad. El código se pasa de boca en boca.',
  texto_puerta_2: 'Si lo tenés, ya sabés qué hacer.',
  texto_pie: 'Derecho de admisión reservado',
  instagram: '',
  whatsapp: '',
  edad_minima: '18',
  permitir_sin_rrpp: '0',
  recargo: '1000',
  metodo_pago: 'transferencia',
  transferencia_alias: '',
  transferencia_cbu: '',
  transferencia_titular: '',
  consentimiento: CONSENTIMIENTO,
};
const NUMEROS = new Set(['edad_minima', 'recargo']);
const SI_NO = new Set(['permitir_sin_rrpp']);

function config() {
  const c = {};
  for (const { clave, valor } of all('SELECT clave, valor FROM configuracion')) {
    c[clave] = NUMEROS.has(clave) ? Number(valor) : SI_NO.has(clave) ? valor === '1' : valor;
  }
  return c;
}

function guardarConfig(cambios) {
  tx(() => {
    for (const [clave, valor] of Object.entries(cambios)) {
      const texto = typeof valor === 'boolean' ? (valor ? '1' : '0') : String(valor);
      run('INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor', clave, texto);
    }
  });
}

// ---------- Datos iniciales (solo la primera vez) ----------

function proximoViernes() {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T23:30`;
}

function cargarDatosIniciales() {
  run('INSERT INTO rrpp (nombre, codigo) VALUES (?, ?)', 'General', Validar.codigo(process.env.INITIAL_CODE || 'MEDIANOCHE'));
  run(
    'INSERT INTO eventos (nombre, fecha, descripcion, direccion) VALUES (?, ?, ?, ?)',
    'Noche de apertura',
    proximoViernes(),
    'Todo negro. Ingreso hasta la 1:30.',
    'Dirección a confirmar',
  );
  // Sin precio y ocultos: el dueño les pone precio y los activa desde el panel.
  ['Entrada VIP', 'Cabina', 'Combo botella'].forEach((nombre, i) => {
    run('INSERT INTO productos (nombre, precio, activo, orden) VALUES (?, 0, 0, ?)', nombre, i + 1);
  });
}

tx(() => {
  const baseNueva = !get('SELECT 1 FROM configuracion LIMIT 1');
  for (const [clave, valor] of Object.entries(POR_DEFECTO)) {
    run('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)', clave, valor);
  }
  run('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)', 'secreto_sesion', crypto.randomBytes(32).toString('hex'));
  if (baseNueva) cargarDatosIniciales();
});

module.exports = { db, all, get, run, tx, config, guardarConfig, CLAVES_CONFIG: Object.keys(POR_DEFECTO) };
