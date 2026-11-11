const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const ejs = require('ejs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luo-schema-test-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const db = require('../db/init');
const { attachUser } = require('../middleware/auth');
const adminRoutes = require('../routes/admin');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use((req, res, next) => {
  const role = req.get('x-test-role');
  req.session = role ? { user_id: 1, username: 'test', role } : {};
  next();
});
app.use(attachUser);
app.use('/admin', adminRoutes);

let server;
let baseUrl;
test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(directory, { recursive: true });
});

test('only admins can view every schema object and its definition', async () => {
  const objects = db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY type, name').all();
  const response = await fetch(`${baseUrl}/admin/schema`, {
    headers: { 'x-test-role': 'admin' }
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(objects.length > 0);
  for (const object of objects) {
    assert.ok(html.includes(`<h2 class="card-header">${ejs.escapeXML(object.name)}</h2>`));
    if (object.sql) {
      assert.ok(html.includes(`<code>${ejs.escapeXML(object.sql)}</code>`));
    } else {
      assert.ok(html.includes('Automatically created by SQLite; no SQL definition is stored.'));
    }
  }
});

test('dashboard links to the schema', async () => {
  const response = await fetch(`${baseUrl}/admin`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /href="\/admin\/schema"/);
});

test('regular users are denied and guests are redirected', async () => {
  const user = await fetch(`${baseUrl}/admin/schema`, { headers: { 'x-test-role': 'user' } });
  assert.equal(user.status, 403);
  const guest = await fetch(`${baseUrl}/admin/schema`, { redirect: 'manual' });
  assert.equal(guest.status, 302);
  assert.equal(guest.headers.get('location'), '/auth/login');
});
