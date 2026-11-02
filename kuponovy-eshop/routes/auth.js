'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../src/db');
const { flash, requireLogin } = require('../src/middleware');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/account');
  res.render('register', { title: 'Registrace', values: {} });
});

router.post('/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email) || password.length < 8) {
    flash(req, 'error', 'Zadej platný e-mail a heslo alespoň 8 znaků.');
    return res.render('register', { title: 'Registrace', values: { email } });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    flash(req, 'error', 'Účet s tímto e-mailem už existuje. Přihlas se.');
    return res.redirect('/login');
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)').run(email, hash);
  req.session.userId = info.lastInsertRowid;
  flash(req, 'success', 'Účet vytvořen.');
  res.redirect('/account');
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/account');
  res.render('login', { title: 'Přihlášení', next: req.query.next || '' });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = req.body.next && req.body.next.startsWith('/') ? req.body.next : '/account';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    flash(req, 'error', 'Nesprávný e-mail nebo heslo.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  flash(req, 'success', 'Přihlášeno.');
  res.redirect(user.is_admin ? '/admin' : next);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/account', requireLogin, (req, res) => {
  const orders = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.session.userId);
  res.render('account', { title: 'Můj účet', orders });
});

module.exports = router;
