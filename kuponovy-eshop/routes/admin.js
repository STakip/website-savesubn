'use strict';

const express = require('express');
const { db, getSettings, setSetting } = require('../src/db');
const service = require('../src/service');
const { sendCodes } = require('../src/mailer');
const { flash, requireLogin, requireAdmin } = require('../src/middleware');

const router = express.Router();
router.use(requireLogin, requireAdmin);

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'produkt';
}
function uniqueSlug(base, ignoreId) {
  let slug = base, i = 2;
  while (true) {
    const row = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
    if (!row || row.id === ignoreId) return slug;
    slug = `${base}-${i++}`;
  }
}
function priceToCents(v) {
  const n = Math.round(parseFloat(String(v).replace(',', '.')) * 100);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// --- Dashboard ---
router.get('/', (req, res) => {
  const stats = {
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pending'").get().n,
    delivered: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'delivered'").get().n,
    revenue: db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM orders WHERE status = 'delivered'").get().s
  };
  const lowStock = db
    .prepare(
      `SELECT p.id, p.name, p.slug,
        (SELECT COUNT(*) FROM coupons c WHERE c.product_id = p.id AND c.status='available') AS stock
       FROM products p WHERE p.active = 1 ORDER BY stock ASC LIMIT 10`
    )
    .all();
  const recent = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8').all();
  res.render('admin/dashboard', { title: 'Admin', stats, lowStock, recent });
});

// --- Produkty ---
router.get('/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all().map((p) => ({
    ...p,
    available: service.availableStock(p.id),
    delivered: db.prepare("SELECT COUNT(*) n FROM coupons WHERE product_id=? AND status='delivered'").get(p.id).n
  }));
  res.render('admin/products', { title: 'Produkty', products });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: 'Nový produkt', product: null });
});

router.post('/products', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Zadej název.'); return res.redirect('/admin/products/new'); }
  const slug = uniqueSlug(slugify(req.body.slug || name));
  db.prepare(
    `INSERT INTO products(slug,name,description,price_cents,currency,image_url,active)
     VALUES(?,?,?,?,?,?,?)`
  ).run(
    slug, name, String(req.body.description || ''),
    priceToCents(req.body.price), (req.body.currency || getSettings().currency).toLowerCase(),
    String(req.body.image_url || '').trim() || null,
    req.body.active ? 1 : 0
  );
  flash(req, 'success', 'Produkt vytvořen. Teď k němu přidej kódy.');
  const id = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug).id;
  res.redirect('/admin/products/' + id + '/edit');
});

router.get('/products/:id/edit', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const counts = {
    available: service.availableStock(product.id),
    reserved: db.prepare("SELECT COUNT(*) n FROM coupons WHERE product_id=? AND status='reserved'").get(product.id).n,
    delivered: db.prepare("SELECT COUNT(*) n FROM coupons WHERE product_id=? AND status='delivered'").get(product.id).n
  };
  const sample = db.prepare("SELECT code,status FROM coupons WHERE product_id=? ORDER BY id DESC LIMIT 30").all(product.id);
  res.render('admin/product-form', { title: 'Upravit produkt', product, counts, sample });
});

router.post('/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const name = String(req.body.name || '').trim() || product.name;
  const slug = uniqueSlug(slugify(req.body.slug || name), product.id);
  db.prepare(
    `UPDATE products SET name=?, slug=?, description=?, price_cents=?, currency=?, image_url=?, active=? WHERE id=?`
  ).run(
    name, slug, String(req.body.description || ''),
    priceToCents(req.body.price), (req.body.currency || product.currency).toLowerCase(),
    String(req.body.image_url || '').trim() || null,
    req.body.active ? 1 : 0, product.id
  );
  flash(req, 'success', 'Uloženo.');
  res.redirect('/admin/products/' + product.id + '/edit');
});

router.post('/products/:id/delete', (req, res) => {
  const has = db.prepare("SELECT COUNT(*) n FROM coupons WHERE product_id=? AND status='delivered'").get(req.params.id).n;
  if (has > 0) {
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
    flash(req, 'success', 'Produkt má doručené kódy, proto byl jen deaktivován (kvůli historii objednávek).');
  } else {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    flash(req, 'success', 'Produkt smazán.');
  }
  res.redirect('/admin/products');
});

// --- Kódy (hromadné vložení) ---
router.post('/products/:id/coupons', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/admin/products');
  const lines = String(req.body.codes || '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const insert = db.prepare("INSERT OR IGNORE INTO coupons(product_id, code) VALUES(?, ?)");
  let added = 0, dup = 0;
  const tx = db.transaction((rows) => {
    for (const code of rows) {
      const info = insert.run(product.id, code);
      if (info.changes) added++; else dup++;
    }
  });
  tx(lines);
  flash(req, 'success', `Přidáno ${added} kódů${dup ? `, ${dup} duplicitních přeskočeno` : ''}.`);
  res.redirect('/admin/products/' + product.id + '/edit');
});

router.post('/products/:id/coupons/clear-available', (req, res) => {
  const info = db.prepare("DELETE FROM coupons WHERE product_id=? AND status='available'").run(req.params.id);
  flash(req, 'success', `Smazáno ${info.changes} nevyužitých kódů.`);
  res.redirect('/admin/products/' + req.params.id + '/edit');
});

// --- Objednávky ---
router.get('/orders', (req, res) => {
  const status = ['pending', 'delivered', 'cancelled', 'paid'].includes(req.query.status) ? req.query.status : null;
  const orders = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 300').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300').all();
  res.render('admin/orders', { title: 'Objednávky', orders, status });
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  const codes = db.prepare('SELECT code,status FROM coupons WHERE order_id = ? ORDER BY id').all(order.id);
  res.render('admin/order', { title: 'Objednávka ' + order.public_id, order, codes });
});

// Ruční potvrzení platby (krypto / IBAN) → doručí kódy + e-mail
router.post('/orders/:id/confirm', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  if (order.status === 'delivered') { flash(req, 'error', 'Už je doručeno.'); return res.redirect('/admin/orders/' + order.id); }
  const { emailed } = await service.markPaidAndDeliver(order.id, process.env.BASE_URL);
  flash(req, 'success', emailed ? 'Platba potvrzena, kódy odeslány e-mailem.' : 'Platba potvrzena a kódy doručeny (SMTP není nastaveno — kódy vidíš níže).');
  res.redirect('/admin/orders/' + order.id);
});

router.post('/orders/:id/cancel', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/admin/orders');
  service.cancelOrder(order.id);
  flash(req, 'success', 'Objednávka zrušena, rezervované kódy vráceny na sklad.');
  res.redirect('/admin/orders/' + order.id);
});

router.post('/orders/:id/resend', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order || order.status !== 'delivered') { flash(req, 'error', 'Objednávka není doručená.'); return res.redirect('/admin/orders'); }
  const codes = service.getDeliveredCodes(order.id);
  const s = getSettings();
  try {
    const ok = await sendCodes({ to: order.email, shopName: s.shop_name, baseUrl: process.env.BASE_URL, order, codes });
    flash(req, ok ? 'success' : 'error', ok ? 'E-mail odeslán znovu.' : 'SMTP není nastaveno, e-mail se neposlal.');
  } catch (e) {
    flash(req, 'error', 'Odeslání selhalo: ' + e.message);
  }
  res.redirect('/admin/orders/' + order.id);
});

// --- Nastavení ---
router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Nastavení' });
});

router.post('/settings', (req, res) => {
  const keys = [
    'shop_name', 'shop_tagline', 'support_email', 'currency',
    'crypto_label', 'crypto_address', 'iban_number', 'iban_holder', 'iban_bank', 'terms'
  ];
  for (const k of keys) if (k in req.body) setSetting(k, k === 'currency' ? String(req.body[k]).toLowerCase() : req.body[k]);
  setSetting('crypto_enabled', req.body.crypto_enabled ? '1' : '0');
  setSetting('iban_enabled', req.body.iban_enabled ? '1' : '0');
  flash(req, 'success', 'Nastavení uloženo.');
  res.redirect('/admin/settings');
});

module.exports = router;
