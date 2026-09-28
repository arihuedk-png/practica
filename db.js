// Almacenamiento simple en un archivo JSON.
// Las escrituras son síncronas (archivo temporal + rename) para que nunca
// queden a medias; es suficiente para una tienda pequeña con un solo proceso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function seed() {
  const now = new Date().toISOString();
  const categories = [
    { id: 1, name: 'Pizzas', order: 1 },
    { id: 2, name: 'Empanadas', order: 2 },
    { id: 3, name: 'Bebidas', order: 3 },
    { id: 4, name: 'Postres', order: 4 },
  ];
  const products = [
    ['Pizza Muzzarella', 'Salsa de tomate, muzzarella y orégano.', 120, 1, true],
    ['Pizza Especial', 'Muzzarella, jamón, morrones y aceitunas.', 150, 1, true],
    ['Pizza Napolitana', 'Muzzarella, rodajas de tomate, ajo y albahaca.', 140, 1, false],
    ['Pizza Fugazzeta', 'Muzzarella y cebolla caramelizada.', 145, 1, false],
    ['Empanada de Carne', 'Carne cortada a cuchillo, huevo y aceituna.', 25, 2, true],
    ['Empanada de Pollo', 'Pollo, cebolla y morrón.', 25, 2, false],
    ['Empanada Jamón y Queso', 'Clásica, bien rellena.', 25, 2, false],
    ['Refresco 1.5 L', 'Sabores varios.', 35, 3, false],
    ['Agua 500 ml', 'Con o sin gas.', 15, 3, false],
    ['Flan casero', 'Con dulce de leche o crema.', 40, 4, false],
    ['Brownie', 'Con nueces.', 45, 4, true],
  ].map(([name, description, price, categoryId, featured], i) => ({
    id: i + 1,
    name,
    description,
    price,
    categoryId,
    image: '',
    active: true,
    featured,
    createdAt: now,
  }));

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@tienda.com').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(`[aviso] Admin creado con contraseña por defecto (${adminEmail} / admin123). Cámbiala con ADMIN_PASSWORD.`);
  }
  const users = [{
    id: 1,
    name: 'Administrador',
    email: adminEmail,
    phone: '',
    role: 'admin',
    ...hashPassword(adminPassword),
    createdAt: now,
  }];

  return {
    settings: {
      storeName: process.env.STORE_NAME || 'Mi Tienda',
      tagline: 'Pide en línea y recíbelo en tu casa',
      whatsapp: process.env.WHATSAPP_NUMBER || '',
      currency: process.env.CURRENCY || 'MXN',
      deliveryFee: 30,
      minOrder: 0,
      isOpen: true,
      hours: 'Lunes a domingo de 19 a 23 h',
      address: '',
      transferInfo: '',
      primaryColor: '#e63946',
    },
    users,
    categories,
    products,
    orders: [],
    counters: { users: 1, categories: categories.length, products: products.length, orders: 0 },
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

module.exports = { data, save, nextId, hashPassword, verifyPassword, UPLOADS_DIR };
