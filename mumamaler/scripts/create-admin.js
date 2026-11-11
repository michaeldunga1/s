const bcrypt = require('bcryptjs');
const { normalizeEmail, isValidEmail } = require('../account');

const email = normalizeEmail(process.argv[2]);
if (!isValidEmail(email)) {
  console.error('Usage: provide an email argument and supply the password on standard input.');
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error('Supply the password on standard input; see the README for an example.');
  process.exit(1);
}
let password = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { password += chunk; });
process.stdin.on('end', async () => {
  password = password.replace(/\r?\n$/, '');
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    console.error('Password must be at least 8 characters and at most 72 bytes.');
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exitCode = 1;
    return;
  }
  const db = require('../postgres');
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(15377001, hashtext(lower($1)))', [email]);
    const existing = await client.query(`
      SELECT 1 FROM admins WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")
      UNION ALL SELECT 1 FROM readers WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")
    `, [email]);
    if (existing.rowCount) throw new Error('An account with that email already exists.');
    await client.query('INSERT INTO admins (email, password_hash) VALUES ($1, $2)', [email, bcrypt.hashSync(password, 10)]);
    await client.query('COMMIT');
    console.log(`Created admin account: ${email}`);
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Admin creation rollback failed:', rollbackError); }
    }
    console.error('Failed to create admin account:', error.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await db.end();
  }
});
