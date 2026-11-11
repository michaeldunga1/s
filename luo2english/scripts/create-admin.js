#!/usr/bin/env node

const bcrypt = require('bcryptjs');

const [username, email] = process.argv.slice(2);
if (!username || !email || process.argv.length !== 4 || process.stdin.isTTY) {
  console.error('Usage: provide username and email as arguments and password on standard input.');
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exitCode = 1;
} else {
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
    const db = require('../db/postgres');
    try {
      const { rows } = await db.query(`
        INSERT INTO users (username, email, password_hash, role)
        VALUES ($1, $2, $3, 'admin') RETURNING id
      `, [username.toLowerCase(), email.toLowerCase(), bcrypt.hashSync(password, 10)]);
      console.log(`Created admin account ${username} (ID ${rows[0].id}).`);
    } catch (error) {
      console.error('Error creating admin user:', error.message);
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  });
}
