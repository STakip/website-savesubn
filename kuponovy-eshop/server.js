'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const SQLiteStore = require('connect-sqlite3')(session);

const { loadContext, csrf } = require('./src/middleware');
const service = require('./src/service');

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // za reverzní proxy (nginx / platforma) kvůli secure cookies
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));

// --- Stripe webhook: potřebuje RAW tělo, proto PŘED parsery ---
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Stripe není nakonfigurováno.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] neplatný podpis:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const order = service.getOrderByStripeSession(s.id);
      if (order && order.status !== 'delivered') {
        await service.markPaidAndDeliver(order.id, process.env.BASE_URL);
        console.log(`[webhook] objednávka ${order.public_id} zaplacena a doručena`);
      }
    }
  } catch (e) {
    console.error('[webhook] chyba zpracování:', e.message);
    return res.status(500).send('chyba');
  }
  res.json({ received: true });
});

// --- Parsery a statika ---
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

// --- Session ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
    secret: process.env.SESSION_SECRET || 'nejaky-nahodny-tajny-klic-zmen-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.SECURE_COOKIES === 'true',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  })
);

app.use(loadContext);
app.use(csrf);

// --- Routy ---
app.use('/', require('./routes/shop')(stripe));
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));

// --- 404 + error handler ---
app.use((req, res) => res.status(404).render('error', { title: 'Nenalezeno', message: 'Stránka neexistuje.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Chyba', message: 'Něco se pokazilo.' });
});

// Uvolňování prošlých rezervací každou hodinu
service.sweepStaleReservations();
setInterval(() => service.sweepStaleReservations(), 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] běží na ${process.env.BASE_URL || 'http://localhost:' + PORT}`);
  if (!stripe) console.log('[server] Stripe vypnuto (chybí STRIPE_SECRET_KEY) — platba kartou se nenabídne.');
});
