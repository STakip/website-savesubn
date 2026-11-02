'use strict';

const express = require('express');
const { db, getSettings } = require('../src/db');
const service = require('../src/service');
const { flash } = require('../src/middleware');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_QTY = 10;

module.exports = function (stripe) {
  const router = express.Router();

  // Domovská stránka — výpis aktivních produktů se skladem
  router.get('/', (req, res) => {
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC').all();
    const withStock = products.map((p) => ({ ...p, stock: service.availableStock(p.id) }));
    res.render('home', { title: res.locals.settings.shop_name, products: withStock });
  });

  // Detail produktu + checkout formulář
  router.get('/p/:slug', (req, res) => {
    const product = service.getProductBySlug(req.params.slug);
    if (!product) return res.status(404).render('error', { title: 'Nenalezeno', message: 'Produkt neexistuje.' });
    const stock = service.availableStock(product.id);
    res.render('product', { title: product.name, product, stock, maxQty: Math.min(MAX_QTY, stock), stripeEnabled: !!stripe });
  });

  // Vytvoření objednávky
  router.post('/checkout', async (req, res) => {
    const s = getSettings();
    const product = service.getProductById(Number(req.body.product_id));
    if (!product || !product.active) {
      flash(req, 'error', 'Produkt není dostupný.');
      return res.redirect('/');
    }
    const quantity = Math.max(1, Math.min(MAX_QTY, parseInt(req.body.quantity, 10) || 1));
    const email = String(req.body.email || '').trim().toLowerCase();
    const method = String(req.body.method || '');

    if (!EMAIL_RE.test(email)) {
      flash(req, 'error', 'Zadej platný e-mail, kam ti pošleme kódy.');
      return res.redirect('/p/' + product.slug);
    }
    const methodEnabled =
      (method === 'stripe' && stripe) ||
      (method === 'crypto' && s.crypto_enabled === '1') ||
      (method === 'iban' && s.iban_enabled === '1');
    if (!methodEnabled) {
      flash(req, 'error', 'Zvolená platební metoda není dostupná.');
      return res.redirect('/p/' + product.slug);
    }

    let order;
    try {
      order = service.createOrder({
        product,
        quantity,
        email,
        userId: req.session.userId || null,
        method
      });
    } catch (e) {
      if (e.code === 'OUT_OF_STOCK') {
        flash(req, 'error', 'Bohužel není dostatek kódů skladem. Zkus menší množství.');
        return res.redirect('/p/' + product.slug);
      }
      throw e;
    }

    if (method === 'stripe') {
      try {
        const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const checkout = await stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: product.currency,
                product_data: { name: product.name },
                unit_amount: product.price_cents
              },
              quantity
            }
          ],
          customer_email: email,
          success_url: `${base}/order/${order.public_id}?paid=1`,
          cancel_url: `${base}/order/${order.public_id}?canceled=1`,
          metadata: { order_id: String(order.id), public_id: order.public_id }
        });
        service.attachStripeSession(order.id, checkout.id);
        return res.redirect(303, checkout.url);
      } catch (e) {
        console.error('[stripe] vytvoření session selhalo:', e.message);
        service.cancelOrder(order.id); // uvolni rezervaci
        flash(req, 'error', 'Platbu kartou se nepodařilo spustit. Zkus jinou metodu.');
        return res.redirect('/p/' + product.slug);
      }
    }

    // Krypto / IBAN — ruční potvrzení
    return res.redirect('/order/' + order.public_id);
  });

  // Stav objednávky (+ fallback ověření Stripe platby)
  router.get('/order/:pid', async (req, res) => {
    const order = service.getOrderByPublicId(req.params.pid);
    if (!order) return res.status(404).render('error', { title: 'Nenalezeno', message: 'Objednávka neexistuje.' });

    // Fallback: kdyby webhook nedorazil, ověř platbu přímo u Stripe při návratu zákazníka.
    if (order.status === 'pending' && order.payment_method === 'stripe' && order.stripe_session && stripe) {
      try {
        const sess = await stripe.checkout.sessions.retrieve(order.stripe_session);
        if (sess && sess.payment_status === 'paid') {
          await service.markPaidAndDeliver(order.id, process.env.BASE_URL);
        }
      } catch (e) {
        console.error('[order] ověření Stripe selhalo:', e.message);
      }
    }

    const fresh = service.getOrderByPublicId(req.params.pid);
    const codes = fresh.status === 'delivered' ? service.getDeliveredCodes(fresh.id) : [];
    res.render('order', { title: 'Objednávka ' + fresh.public_id, order: fresh, codes });
  });

  // Zákazník doplní referenci / txid k ruční platbě
  router.post('/order/:pid/note', (req, res) => {
    const order = service.getOrderByPublicId(req.params.pid);
    if (!order) return res.status(404).render('error', { title: 'Nenalezeno', message: 'Objednávka neexistuje.' });
    const note = String(req.body.note || '').slice(0, 500);
    db.prepare('UPDATE orders SET reference = ? WHERE id = ?').run(note, order.id);
    flash(req, 'success', 'Díky, informaci jsme uložili. Po ověření platby ti pošleme kódy na e-mail.');
    res.redirect('/order/' + order.public_id);
  });

  return router;
};
