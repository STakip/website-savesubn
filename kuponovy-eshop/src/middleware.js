'use strict';

const crypto = require('crypto');
const { db, getSettings } = require('./db');

// Načte přihlášeného uživatele a globální data do res.locals pro všechny šablony.
function loadContext(req, res, next) {
  const settings = getSettings();
  res.locals.settings = settings;
  res.locals.user = null;
  if (req.session && req.session.userId) {
    const u = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (u) res.locals.user = u;
  }
  // Flash zprávy (jednorázové)
  res.locals.flash = req.session.flash || null;
  if (req.session) delete req.session.flash;
  // Pomocné formátování ceny
  res.locals.formatPrice = (cents, currency) => {
    const v = (cents / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return `${v} ${String(currency || settings.currency).toUpperCase()}`;
  };
  res.locals.currentPath = req.path;
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    flash(req, 'error', 'Nejprve se přihlas.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user || !res.locals.user.is_admin) {
    return res.status(403).render('error', { title: 'Zakázáno', message: 'Nemáš oprávnění.' });
  }
  next();
}

// --- Jednoduchá CSRF ochrana pro formuláře (token v session) ---
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (!sent || sent !== req.session.csrf) {
      return res.status(403).render('error', { title: 'Neplatný požadavek', message: 'Vypršela platnost formuláře, zkus to prosím znovu.' });
    }
  }
  next();
}

module.exports = { loadContext, flash, requireLogin, requireAdmin, csrf };
