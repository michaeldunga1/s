const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luo-users-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const db = require('../db/init');
const { validateSession, attachUser } = require('../middleware/auth');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
app.use(validateSession, attachUser);
app.use('/', require('../routes/public'));
app.use('/auth', require('../routes/auth'));
app.use('/admin', require('../routes/admin'));
const password = bcrypt.hashSync('password123', 4);
const adminId = db.prepare("INSERT INTO users (username,email,password_hash,role) VALUES ('admin','admin@example.com',?,'admin')").run(password).lastInsertRowid;
const userId = db.prepare("INSERT INTO users (username,email,password_hash,role) VALUES ('reader','reader@example.com',?,'user')").run(password).lastInsertRowid;
const otherId = db.prepare("INSERT INTO users (username,email,password_hash,role) VALUES ('other','other@example.com',?,'user')").run(password).lastInsertRowid;
const wordId = db.prepare("INSERT INTO words (word, definition) VALUES ('word', 'meaning')").run().lastInsertRowid;
const commentId = db.prepare("INSERT INTO comments (word_id,user_id,body) VALUES (?,?,'comment')").run(wordId, userId).lastInsertRowid;
db.prepare('INSERT INTO votes (comment_id,user_id,value) VALUES (?,?,1)').run(commentId, otherId);
let server;
let base;
class Client {
  constructor() { this.cookie = ''; }
  async request(url, options = {}) {
    const response = await fetch(base + url, { ...options, redirect: 'manual', headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return response;
  }
  post(url, values) {
    return this.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  }
}
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(directory, { recursive: true });
});

test('public legal pages and footer links are available', async () => {
  const guest = new Client();
  for (const [url, title] of [['/privacy', 'Privacy policy'], ['/terms', 'Terms of use'], ['/cookies', 'Cookie and storage notice']]) {
    const response = await guest.request(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(title));
    assert.match(html, /Draft:/);
    for (const link of ['/privacy', '/terms', '/cookies']) assert.ok(html.includes(`href="${link}"`));
  }
  const home = await (await guest.request('/')).text();
  assert.match(home, /aria-hidden="true"><use href="\/icons.svg#dictionary"/);
  for (const link of ['/privacy', '/terms', '/cookies']) assert.ok(home.includes(`href="${link}"`));
  const privacy = await (await guest.request('/privacy')).text();
  assert.match(privacy, /Contabo/);
  assert.match(privacy, /comments and votes/i);
});

test('dictionary search matches words and definitions without JavaScript', async () => {
  const guest = new Client();
  db.prepare("INSERT INTO words (word, definition) VALUES ('Nying', 'An English Name with 100% meaning')").run();
  const byWord = await (await guest.request('/?q=NYING')).text();
  assert.match(byWord, /Nying/);
  assert.doesNotMatch(byWord, /href="\/word\/1"/);
  const byDefinition = await (await guest.request('/?q=english%20name')).text();
  assert.match(byDefinition, /Nying/);
  assert.match(await (await guest.request('/?q=%25')).text(), /Nying/);
  assert.match(await (await guest.request('/?q=absent')).text(), /No matching words found/);
  assert.equal((await guest.request('/?q=a&q=b')).status, 400);
  assert.equal((await guest.request(`/?q=${'x'.repeat(201)}`)).status, 400);
});

test('admin user management is protected and deletes user contributions and sessions', async () => {
  const guest = new Client();
  assert.doesNotMatch(await (await guest.request('/')).text(), /href="\/admin\/users">Users/);
  assert.equal((await guest.request('/admin/users')).headers.get('location'), '/auth/login');
  const reader = new Client();
  await reader.post('/auth/login', { username: 'reader', password: 'password123' });
  assert.doesNotMatch(await (await reader.request('/')).text(), /href="\/admin\/users">Users/);
  assert.equal((await reader.request('/admin/users')).status, 403);
  const admin = new Client();
  await admin.post('/auth/login', { username: 'admin', password: 'password123' });
  const html = await (await admin.request('/admin/users')).text();
  assert.match(html, /href="\/admin\/users">Users/);
  assert.match(html, /reader@example.com/);
  assert.match(html, /admin@example.com/);
  assert.doesNotMatch(html, /aria-label="Delete admin"/);
  const page = await (await admin.request(`/admin/users/${userId}/delete`)).text();
  const token = page.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await reader.post(`/admin/users/${userId}/delete`, { _csrf: token, confirm: 'delete' })).status, 403);
  assert.equal((await admin.post(`/admin/users/${userId}/delete`, { _csrf: 'invalid', confirm: 'delete' })).status, 403);
  assert.equal((await admin.post(`/admin/users/${userId}/delete`, { _csrf: token })).status, 400);
  assert.equal((await admin.post(`/admin/users/${adminId}/delete`, { _csrf: token, confirm: 'delete' })).status, 404);
  assert.equal((await admin.post(`/admin/users/${userId}/delete`, { _csrf: token, confirm: 'delete' })).status, 302);
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
  assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get(commentId), undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM votes WHERE comment_id = ?').get(commentId).n, 0);
  assert.ok(db.prepare('SELECT id FROM words WHERE id = ?').get(wordId));
  assert.equal((await reader.request('/profile')).headers.get('location'), '/auth/login');
  assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(adminId));
});
