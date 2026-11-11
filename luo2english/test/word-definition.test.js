const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luo-migration-test-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT);
  CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE definitions (id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, definition TEXT NOT NULL);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, definition_id));
  CREATE TABLE votes (id INTEGER PRIMARY KEY, comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), value INTEGER NOT NULL, UNIQUE(user_id, comment_id));
  INSERT INTO users VALUES (1, 'user', 'user@example.com', 'hash', 'user'), (2, 'voter', 'voter@example.com', 'hash', 'user');
  INSERT INTO words (id, word) VALUES (10, 'test'), (11, 'empty');
  INSERT INTO definitions VALUES (2, 10, 'First'), (4, 10, 'Second');
  INSERT INTO comments (id, definition_id, user_id, body) VALUES (6, 2, 1, 'One'), (7, 4, 1, 'Two');
  INSERT INTO votes (id, comment_id, user_id, value) VALUES (8, 7, 2, 1);
`);
legacy.close();
const db = require('../db/init');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, res, next) => {
  const role = req.get('x-test-role');
  req.session = role ? { user_id: role === 'admin' ? 2 : 1, username: 'test', role } : {};
  next();
});
app.use(require('../middleware/auth').attachUser);
app.use('/', require('../routes/public'));
app.use('/admin', require('../routes/admin'));
app.use('/comments', require('../routes/comments'));

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(directory, { recursive: true });
});
function request(url, options = {}) {
  return fetch(base + url, { redirect: 'manual', ...options });
}
function post(url, data, role = 'admin') {
  return request(url, { method: 'POST', headers: { 'x-test-role': role, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
}

test('migration joins definitions and preserves comments, votes and empty words', async () => {
  assert.equal(db.prepare('SELECT definition FROM words WHERE id = 10').get().definition, 'First\n\nSecond');
  assert.equal(db.prepare('SELECT definition FROM words WHERE id = 11').get().definition, '');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'definitions'").get().n, 0);
  assert.deepEqual(db.prepare('SELECT id, word_id FROM comments ORDER BY id').all(), [{ id: 6, word_id: 10 }, { id: 7, word_id: 10 }]);
  assert.equal(db.prepare('SELECT comment_id FROM votes WHERE id = 8').get().comment_id, 7);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const detail = await (await request('/word/10')).text();
  assert.match(detail, /First\n\nSecond/);
  assert.match(detail, /One/);
  assert.match(detail, /Two/);
  assert.equal((await post('/comments/10', { body: 'Third' }, 'user')).status, 409);
});

test('admin creates and edits a word with one definition and public pages show it', async () => {
  const form = await (await request('/admin/words/new', { headers: { 'x-test-role': 'admin' } })).text();
  assert.equal((form.match(/name="definition"/g) || []).length, 1);
  assert.equal((await post('/admin/words', { word: 'NewWord', definition: 'Meaning one\n\nMeaning two' })).status, 302);
  const word = db.prepare("SELECT * FROM words WHERE word = 'newword'").get();
  assert.equal(word.definition, 'Meaning one\n\nMeaning two');
  assert.match(await (await request(`/word/${word.id}`)).text(), /Meaning one\n\nMeaning two/);
  assert.equal((await post(`/admin/words/${word.id}`, { word: 'NewWord', definition: 'Updated <meaning>' })).status, 302);
  assert.match(await (await request(`/word/${word.id}`)).text(), /Updated &lt;meaning&gt;/);
  assert.equal((await post('/admin/words', { word: 'newword', definition: 'Duplicate' })).status, 409);
  assert.equal((await post('/admin/words', { word: 'blocked', definition: 'x' }, 'user')).status, 403);
  assert.equal((await post(`/comments/${word.id}`, { body: 'A comment' }, 'user')).status, 200);
  assert.equal((await post(`/comments/${word.id}`, { body: 'Duplicate' }, 'user')).status, 409);
  assert.equal((await post('/comments/99999', { body: 'Missing' }, 'user')).status, 404);
  assert.equal((await post(`/admin/words/${word.id}/delete`, {})).status, 302);
  assert.equal(db.prepare('SELECT count(*) AS n FROM comments WHERE word_id = ?').get(word.id).n, 0);
});
