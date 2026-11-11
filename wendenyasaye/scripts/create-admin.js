const bcrypt = require('bcryptjs');
const { normalizeEmail, isValidEmail } = require('../account');

const email = normalizeEmail(process.argv[2]);
if (!isValidEmail(email)) {
  console.error('Usage: provide an email address as the first argument and a password on standard input.');
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error('Provide the password on standard input. See README.md for a safe shell example.');
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
  const repository = new (require('../postgres-repository').PostgresRepository)({ connectionString: process.env.DATABASE_URL });
  try {
    await repository.createUser(email, email, bcrypt.hashSync(password, 10), 'admin');
    console.log(`Created admin account: ${email}`);
  } catch (error) {
    console.error('Failed to create admin:', error.message);
    process.exitCode = 1;
  } finally {
    if (repository.close) await repository.close();
  }
});
