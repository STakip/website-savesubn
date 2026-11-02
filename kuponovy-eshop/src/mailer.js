'use strict';

const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true = port 465
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
}

const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@example.com';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Pošle zákazníkovi doručené kódy. Pokud SMTP není nakonfigurované,
 * jen zaloguje a vrátí false (kódy jsou pořád vidět v adminu a na stránce objednávky).
 */
async function sendCodes({ to, shopName, baseUrl, order, codes }) {
  const codeList = codes.map((c) => `<li style="font-family:monospace;font-size:16px;margin:4px 0">${esc(c)}</li>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="margin-bottom:4px">${esc(shopName)}</h2>
      <p>Děkujeme za nákup. Platba za objednávku <strong>${esc(order.public_id)}</strong> byla potvrzena.</p>
      <p><strong>${esc(order.product_name)}</strong> — ${order.quantity}× kód:</p>
      <ul style="background:#f4f4f5;padding:16px 16px 16px 36px;border-radius:8px">${codeList}</ul>
      <p style="color:#555;font-size:13px">Objednávku a kódy najdeš také zde:<br>
        <a href="${esc(baseUrl)}/order/${esc(order.public_id)}">${esc(baseUrl)}/order/${esc(order.public_id)}</a></p>
    </div>`;
  const text =
    `${shopName}\n\nDěkujeme za nákup. Objednávka ${order.public_id} byla potvrzena.\n` +
    `${order.product_name} — ${order.quantity}x kód:\n` +
    codes.map((c) => `  ${c}`).join('\n') +
    `\n\nDetail objednávky: ${baseUrl}/order/${order.public_id}\n`;

  if (!transporter) {
    console.log(`[mailer] SMTP nenastaveno — kódy pro ${to} (objednávka ${order.public_id}): ${codes.join(', ')}`);
    return false;
  }
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: `${shopName} — tvoje kódy (${order.public_id})`,
    text,
    html
  });
  return true;
}

module.exports = { sendCodes, mailerReady: !!transporter };
