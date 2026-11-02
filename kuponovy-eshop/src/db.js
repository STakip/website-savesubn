'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Databáze se ukládá do složky data/ (drž ji na perzistentním disku).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'shop.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  image_url   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'available', -- available | reserved | delivered
  order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, code)
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT UNIQUE NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  product_name    TEXT NOT NULL,
  email           TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  payment_method  TEXT NOT NULL,            -- stripe | crypto | iban
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | paid | delivered | cancelled
  reference       TEXT,                     -- platební reference (VS u IBAN, poznámka u krypta)
  stripe_session  TEXT,
  admin_note      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT,
  delivered_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_coupons_lookup ON coupons(product_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
`);

// ---- Výchozí nastavení (editovatelné v adminu) ----
const DEFAULT_SETTINGS = {
  shop_name: 'Můj kupónový obchod',
  shop_tagline: 'Kódy doručené na e-mail ihned po zaplacení',
  support_email: process.env.ADMIN_EMAIL || 'admin@example.com',
  currency: (process.env.CURRENCY || 'czk').toLowerCase(),
  crypto_enabled: process.env.CRYPTO_ENABLED === 'true' ? '1' : '0',
  crypto_label: process.env.CRYPTO_LABEL || 'Bitcoin (BTC)',
  crypto_address: process.env.CRYPTO_ADDRESS || '',
  iban_enabled: process.env.IBAN_ENABLED === 'true' ? '1' : '0',
  iban_number: process.env.IBAN_NUMBER || '',
  iban_holder: process.env.IBAN_HOLDER || '',
  iban_bank: process.env.IBAN_BANK || '',
  terms: 'Kódy jsou digitální zboží. Po doručení kódu na e-mail není možné vrácení peněz, pokud zákon nestanoví jinak.'
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!getSettingStmt.get(k)) setSettingStmt.run(k, v);
}

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value ?? ''));
}
function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

// ---- Seed admin účtu z .env (jen pokud ještě není žádný admin) ----
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    // Zajisti, že je to admin.
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users(email, password_hash, is_admin) VALUES(?, ?, 1)').run(email, hash);
  console.log(`[db] Vytvořen admin účet: ${email}`);
}
seedAdmin();

module.exports = { db, getSetting, setSetting, getSettings };
