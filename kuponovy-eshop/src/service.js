'use strict';

const { customAlphabet } = require('nanoid');
const { db, getSettings } = require('./db');
const { sendCodes } = require('./mailer');

const publicId = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);

function availableStock(productId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM coupons WHERE product_id = ? AND status = 'available'")
    .get(productId).n;
}

function getProductBySlug(slug) {
  return db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(slug);
}
function getProductById(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/**
 * Vytvoří objednávku a REZERVUJE kódy (status 'reserved'), aby se neprodaly dvakrát.
 * Vše v jedné transakci. Když není dost skladem, vyhodí chybu OUT_OF_STOCK.
 */
const createOrder = db.transaction(({ product, quantity, email, userId, method, reference }) => {
  const codes = db
    .prepare("SELECT id FROM coupons WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT ?")
    .all(product.id, quantity);
  if (codes.length < quantity) {
    const err = new Error('OUT_OF_STOCK');
    err.code = 'OUT_OF_STOCK';
    throw err;
  }
  const pid = publicId();
  const info = db
    .prepare(
      `INSERT INTO orders(public_id, user_id, product_id, product_name, email, quantity, amount_cents, currency, payment_method, status, reference)
       VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?)`
    )
    .run(pid, userId || null, product.id, product.name, email, quantity, product.price_cents * quantity, product.currency, method, reference || null);
  const orderId = info.lastInsertRowid;
  const upd = db.prepare("UPDATE coupons SET status = 'reserved', order_id = ? WHERE id = ?");
  for (const c of codes) upd.run(orderId, c.id);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

function attachStripeSession(orderId, sessionId) {
  db.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').run(sessionId, orderId);
}

function getOrderByPublicId(pid) {
  return db.prepare('SELECT * FROM orders WHERE public_id = ?').get(pid);
}
function getOrderByStripeSession(sid) {
  return db.prepare('SELECT * FROM orders WHERE stripe_session = ?').get(sid);
}
function getDeliveredCodes(orderId) {
  return db
    .prepare('SELECT code FROM coupons WHERE order_id = ? ORDER BY id')
    .all(orderId)
    .map((r) => r.code);
}

// Označí objednávku jako zaplacenou, kódy jako doručené a vrátí kódy.
const _markPaid = db.transaction((orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'delivered') return { order, codes: getDeliveredCodes(orderId), already: true };
  db.prepare("UPDATE orders SET status = 'delivered', paid_at = COALESCE(paid_at, datetime('now')), delivered_at = datetime('now') WHERE id = ?").run(orderId);
  db.prepare("UPDATE coupons SET status = 'delivered' WHERE order_id = ? AND status = 'reserved'").run(orderId);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return { order: updated, codes: getDeliveredCodes(orderId), already: false };
});

/**
 * Potvrdí platbu, doručí kódy a pošle e-mail. Vrací { order, codes, emailed }.
 */
async function markPaidAndDeliver(orderId, baseUrl) {
  const { order, codes, already } = _markPaid(orderId);
  let emailed = false;
  if (!already) {
    const s = getSettings();
    try {
      emailed = await sendCodes({
        to: order.email,
        shopName: s.shop_name,
        baseUrl: baseUrl || process.env.BASE_URL || '',
        order,
        codes
      });
    } catch (e) {
      console.error('[service] odeslání e-mailu selhalo:', e.message);
    }
  }
  return { order, codes, emailed };
}

// Zruší objednávku a uvolní rezervované kódy zpět na sklad.
const cancelOrder = db.transaction((orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status === 'delivered') return order;
  db.prepare("UPDATE coupons SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(orderId);
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

// Uvolní staré nezaplacené rezervace (default 7 dní), aby se kódy nezablokovaly navždy.
function sweepStaleReservations(days = 7) {
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at < datetime('now', ?)")
    .all(`-${days} days`);
  for (const o of stale) cancelOrder(o.id);
  if (stale.length) console.log(`[service] uvolněno ${stale.length} prošlých rezervací`);
}

module.exports = {
  availableStock,
  getProductBySlug,
  getProductById,
  createOrder,
  attachStripeSession,
  getOrderByPublicId,
  getOrderByStripeSession,
  getDeliveredCodes,
  markPaidAndDeliver,
  cancelOrder,
  sweepStaleReservations
};
