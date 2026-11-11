const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { schema } = require('../scripts/export-postgres');

test('PostgreSQL application supports public browsing, accounts and admin changes', {
  skip: process.env.POSTGRES_TEST !== '1' ? 'Set POSTGRES_TEST=1 and PostgreSQL connection environment variables to run.' : false
}, async () => {
  const namespace = `wende_app_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool();
  let server;
  let app;
  const previousUrl = process.env.DATABASE_URL;
  const previousOptions = process.env.PGOPTIONS;
  const previousSecret = process.env.SESSION_SECRET;
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  try {
    process.env.DATABASE_URL = process.env.POSTGRES_TEST_URL;
    if (!process.env.DATABASE_URL) throw new Error('POSTGRES_TEST_URL is required for application integration tests.');
    process.env.PGOPTIONS = `-c search_path=${namespace},pg_catalog`;
    process.env.SESSION_SECRET = 'integration-test-secret';
    const setup = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await setup.query(schema);
      await setup.query('INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)', [
        'admin@example.com', 'admin@example.com', bcrypt.hashSync('password123', 4), 'admin'
      ]);
      await setup.query("INSERT INTO categories (name) VALUES ('Praise')");
    } finally {
      await setup.end();
    }
    app = require('../app');
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    let base = `http://127.0.0.1:${server.address().port}`;
    class Client {
      constructor() { this.cookie = ''; }
      async request(url, options = {}) {
        const response = await fetch(base + url, {
          ...options, redirect: 'manual',
          headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) }
        });
        const cookie = response.headers.get('set-cookie');
        if (cookie) this.cookie = cookie.split(';')[0];
        return response;
      }
      async token(url) {
        const html = await (await this.request(url)).text();
        const match = html.match(/name="_csrf" value="([^"]+)"/);
        assert.ok(match, `Missing token on ${url}`);
        return match[1];
      }
      async post(url, values, token) {
        return this.request(url, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...values, _csrf: token })
        });
      }
    }
    const administrator = new Client();
    let token = await administrator.token('/login');
    assert.equal((await administrator.post('/login', { email: 'admin@example.com', password: 'password123' }, token)).status, 302);
    token = await administrator.token('/admin/hymns/new');
    assert.equal((await administrator.post('/admin/hymns/new', {
      title: 'Postgres Hymn', number: '12', lyrics: 'A searchable verse',
      author: 'A Writer', composer: 'A Composer; Another', categories: '1'
    }, token)).status, 302);
    const publicClient = new Client();
    const listing = await (await publicClient.request('/?q=searchable')).text();
    assert.match(listing, /Postgres Hymn/);
    assert.match(await (await publicClient.request('/composers?name=A%20Composer')).text(), /Postgres Hymn/);
    assert.match(await (await publicClient.request('/categories?q=pra')).text(), /Praise/);
    assert.match(await (await administrator.request('/admin/categories')).text(), /Praise/);
    assert.match(await (await publicClient.request('/hymns/postgres-hymn')).text(), /A searchable verse/);
    const api = await (await publicClient.request('/api/hymns')).json();
    assert.deepEqual(api[0].categories, [{ id: 1, name: 'Praise' }]);
    assert.equal((await publicClient.request('/authors/not-a-number')).status, 404);
    const reader = new Client();
    token = await reader.token('/register');
    assert.equal((await reader.post('/register', { email: 'reader@example.com', password: 'password123' }, token)).status, 302);
    const duplicate = new Client();
    const duplicateToken = await duplicate.token('/register');
    assert.equal((await duplicate.post('/register', { email: 'READER@example.com', password: 'password123' }, duplicateToken)).status, 409);
    assert.equal((await reader.request('/admin')).status, 403);
    token = await reader.token('/hymns/postgres-hymn');
    assert.equal((await reader.post(`/bookmarks/${api[0].id}`, { action: 'add' }, token)).status, 302);
    assert.equal((await reader.post(`/bookmarks/${api[0].id}/edit`, { note: 'Private note', tags: 'tag' }, token)).status, 302);
    assert.match(await (await reader.request('/profile')).text(), /Private note/);
    assert.doesNotMatch(await (await administrator.request('/profile')).text(), /Private note/);
    assert.equal((await reader.post(`/favorites/${api[0].id}`, { action: 'add' }, token)).status, 302);
    assert.match(await (await reader.request('/')).text(), /data-favorite="true"/);
    assert.equal((await reader.request('/bookmarks/not-an-id/edit')).status, 404);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
    await app.locals.sessionStore.close();
    await app.locals.repository.close();
    delete require.cache[require.resolve('../app')];
    app = require('../app');
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await reader.request('/profile')).text(), /Private note/);
    token = await administrator.token('/admin/categories');
    assert.equal((await administrator.post('/admin/categories', { name: 'PRAISE' }, token)).status, 409);
    assert.equal((await administrator.post('/admin/categories', { name: 'Service' }, token)).status, 302);
    assert.match(await (await administrator.request('/admin/categories')).text(), /Service/);
    token = await administrator.token(`/admin/hymns/${api[0].id}/edit`);
    assert.equal((await administrator.post(`/admin/hymns/${api[0].id}/edit`, {
      title: 'Edited Postgres Hymn', number: '12', lyrics: 'Updated', author: 'A Writer', composer: 'A Composer', categories: '1'
    }, token)).status, 302);
    assert.match(await (await publicClient.request('/hymns/postgres-hymn')).text(), /Edited Postgres Hymn/);
    assert.equal((await administrator.post(`/admin/hymns/${api[0].id}/delete`, {}, token)).status, 302);
    assert.equal((await publicClient.request('/hymns/postgres-hymn')).status, 404);
    assert.doesNotMatch(await (await reader.request('/profile')).text(), /Private note/);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (app) {
      if (app.locals.sessionStore) await app.locals.sessionStore.close();
      await app.locals.repository.close();
    }
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = previousOptions;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await admin.end();
  }
});
