const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { specs } = require('../../postgres-migration/export');

test('PostgreSQL Bible reader supports browsing, administration and private bookmarks', async () => {
  const url = process.env.POSTGRES_TEST_URL;
  if (!url) throw new Error('POSTGRES_TEST_URL is required');
  const schema = `muma_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  let created = false;
  let app;
  let server;
  const prior = { DATABASE_URL: process.env.DATABASE_URL, PGOPTIONS: process.env.PGOPTIONS, SESSION_SECRET: process.env.SESSION_SECRET };
  class Client {
    constructor() { this.cookie = ''; }
    async request(path, options = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        ...options, redirect: 'manual', headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) }
      });
      const cookie = response.headers.get('set-cookie');
      if (cookie) this.cookie = cookie.split(';')[0];
      return response;
    }
    async token(path) {
      const response = await this.request(path);
      const html = await response.text();
      const match = html.match(/name="_csrf" value="([^"]+)"/);
      assert.ok(match, `Missing token at ${path} (status ${response.status})`);
      return match[1];
    }
    post(path, values, token) {
      return this.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...values, _csrf: token }) });
    }
  }
  async function start() {
    delete require.cache[require.resolve('../app')];
    delete require.cache[require.resolve('../postgres')];
    app = require('../app');
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  }
  async function stop() {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
    await app.locals.sessionStore.close();
    await app.locals.db.end();
    app = undefined;
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    process.env.DATABASE_URL = url;
    process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
    process.env.SESSION_SECRET = 'integration-test-secret';
    const setup = new Pool({ connectionString: url });
    try {
      await setup.query(specs.mumamaler.schema);
      await setup.query('INSERT INTO admins (email,password_hash) VALUES ($1,$2)', ['admin@example.test', bcrypt.hashSync('password123', 4)]);
    } finally { await setup.end(); }
    await start();
    const guest = new Client();
    const administrator = new Client();
    const reader = new Client();
    const other = new Client();
    assert.equal((await guest.request('/admin')).status, 302);
    let token = await administrator.token('/login');
    assert.equal((await administrator.post('/login', { email: 'ADMIN@example.test', password: 'password123' }, token)).status, 302);
    token = await administrator.token('/admin/books/new');
    const book = { name: 'Test Book', book_order: '1', testament: 'old', author: 'Writer', category: 'History' };
    assert.equal((await administrator.post('/admin/books/new', book, token)).status, 302);
    assert.equal((await administrator.post('/admin/books/new', book, token)).status, 409);
    assert.equal((await administrator.post('/admin/books/new', { ...book, name: 'Conflicting Order', author: 'Rollback Author' }, token)).status, 409);
    assert.equal((await app.locals.db.query("SELECT count(*)::int AS n FROM authors WHERE name='Rollback Author'")).rows[0].n, 0);
    const { rows: [savedBook] } = await app.locals.db.query('SELECT id, slug FROM books WHERE name=$1', [book.name]);
    token = await administrator.token(`/admin/books/${savedBook.id}/chapters/new`);
    const chapter = { number: '1', chapter_title: 'Beginning', body: 'First verse <escaped>' };
    assert.equal((await administrator.post(`/admin/books/${savedBook.id}/chapters/new`, chapter, token)).status, 302);
    assert.equal((await administrator.post(`/admin/books/${savedBook.id}/chapters/new`, chapter, token)).status, 409);
    assert.equal((await administrator.post(`/admin/books/${savedBook.id}/chapters/new`, { ...chapter, number: '2' }, token)).status, 302);
    assert.equal((await app.locals.db.query("SELECT slug FROM chapters WHERE book_id=$1 AND number=2", [savedBook.id])).rows[0].slug, 'beginning-2');
    const firstChapter = (await app.locals.db.query('SELECT id FROM chapters WHERE book_id=$1 AND number=1', [savedBook.id])).rows[0];
    assert.equal((await administrator.post(`/admin/books/${savedBook.id}/chapters/${firstChapter.id}/edit`, { ...chapter, chapter_title: 'Changed title' }, token)).status, 302);
    assert.equal((await app.locals.db.query('SELECT slug FROM chapters WHERE id=$1', [firstChapter.id])).rows[0].slug, 'beginning');
    const page = `/books/${savedBook.slug}/chapters/beginning`;
    assert.match(await (await guest.request(page)).text(), /First verse &lt;escaped&gt;/);
    assert.match(await (await guest.request('/search?q=verse')).text(), /Test Book/);
    assert.match(await (await guest.request('/authors/writer')).text(), /Test Book/);
    assert.match(await (await guest.request('/categories/history')).text(), /Test Book/);
    assert.match(await (await guest.request('/testaments/old')).text(), /Test Book/);
    assert.match(await (await guest.request('/authors')).text(), /1 book</);
    for (const [client, email] of [[reader, 'reader@example.test'], [other, 'other@example.test']]) {
      token = await client.token('/register');
      assert.equal((await client.post('/register', { email, password: 'password123', confirmation: 'password123' }, token)).status, 302);
      assert.equal((await client.request('/admin')).status, 302);
    }
    const duplicate = new Client();
    token = await duplicate.token('/register');
    assert.equal((await duplicate.post('/register', { email: 'READER@example.test', password: 'password123', confirmation: 'password123' }, token)).status, 409);
    assert.equal((await duplicate.post('/register', { email: 'ADMIN@example.test', password: 'password123', confirmation: 'password123' }, token)).status, 409);
    const contenderA = new Client();
    const contenderB = new Client();
    const [tokenA, tokenB] = await Promise.all([contenderA.token('/register'), contenderB.token('/register')]);
    const attempts = await Promise.all([
      contenderA.post('/register', { email: 'race@example.test', password: 'password123', confirmation: 'password123' }, tokenA),
      contenderB.post('/register', { email: 'RACE@example.test', password: 'password123', confirmation: 'password123' }, tokenB)
    ]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [302, 409]);
    token = await reader.token(page);
    assert.equal((await reader.post(`${page}/saved/bookmarks`, { action: 'add' }, 'invalid')).status, 403);
    assert.equal((await reader.post(`${page}/saved/bookmarks`, { action: 'add' }, token)).status, 302);
    assert.equal((await reader.post(`${page}/bookmark/edit`, { note: 'Private note', tags: 'private tag' }, token)).status, 302);
    assert.match(await (await reader.request('/profile')).text(), /Private note/);
    assert.doesNotMatch(await (await other.request('/profile')).text(), /Private note/);
    assert.equal((await other.request(`${page}/bookmark/edit`)).status, 404);
    assert.equal((await reader.post(`${page}/bookmark/edit`, { note: 'x'.repeat(5001), tags: '' }, token)).status, 400);
    assert.equal((await administrator.request('/admin/schema')).status, 200);
    assert.equal((await administrator.request('/admin/books/not-a-number/edit')).status, 404);
    await stop();
    await start();
    assert.match(await (await reader.request('/profile')).text(), /Private note/);
    assert.equal((await administrator.request('/admin')).status, 200);
    const id = (await app.locals.db.query("SELECT id FROM readers WHERE email='reader@example.test'")).rows[0].id;
    const deletePage = await (await administrator.request(`/admin/readers/${id}/delete`)).text();
    token = deletePage.match(/name="_csrf" value="([^"]+)"/)[1];
    const accountToken = deletePage.match(/name="accountToken" value="([^"]+)"/)[1];
    assert.equal((await administrator.post(`/admin/readers/${id}/delete`, { accountToken, confirm: 'delete' }, token)).status, 302);
    assert.equal((await reader.request('/profile')).headers.get('location'), '/login');
    assert.equal((await app.locals.db.query('SELECT count(*)::int AS n FROM saved_chapters WHERE reader_id=$1', [id])).rows[0].n, 0);
    token = await administrator.token('/admin');
    assert.equal((await administrator.post(`/admin/books/${savedBook.id}/delete`, {}, token)).status, 302);
    assert.equal((await guest.request(page)).status, 404);
  } finally {
    if (server) await stop();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
