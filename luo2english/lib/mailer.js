const nodemailer = require('nodemailer');

let transport;

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  }
  return transport;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendPasswordResetEmail({ to, username, resetUrl }) {
  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST is not configured; cannot send password reset email');
    }
    console.warn(`[mail] SMTP not configured; password reset link for ${to}: ${resetUrl}`);
    return false;
  }

  const from = process.env.MAIL_FROM || 'Luo2English <no-reply@swiftener.com>';
  const text = [
    `Hello ${username},`,
    '',
    'We received a request to reset the password for your Luo2English account.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'This link expires in 1 hour. If you did not request a password reset, you can ignore this email.'
  ].join('\n');

  const html = `
    <p>Hello ${escapeHtml(username)},</p>
    <p>We received a request to reset the password for your Luo2English account.</p>
    <p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>
    <p>This link expires in 1 hour. If you did not request a password reset, you can ignore this email.</p>
  `;

  await getTransport().sendMail({
    from,
    to,
    subject: 'Reset your Luo2English password',
    text,
    html
  });
  return true;
}

module.exports = { sendPasswordResetEmail };
