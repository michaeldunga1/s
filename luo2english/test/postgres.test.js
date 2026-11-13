const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { specs } = require('../../postgres-migration/export');

test('PostgreSQL application preserves dictionary, accounts, voting and sessions', async () => {
  const url = process.env.POSTGRES_TEST_URL;
  if (!url) throw new Error('POSTGRES_TEST_URL is required');
  const schema = `luo_test_${crypto.randomBytes(8).toString('hex')}`;
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
    post(path, values) {
      return this.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
    }
    json(path, method, values) {
      return this.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    }
  }
  async function start() {
    for (const module of ['../app', '../db/postgres', '../middleware/auth', '../routes/public', '../routes/auth', '../routes/comments', '../routes/admin']) {
      delete require.cache[require.resolve(module)];
    }
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
      await setup.query(specs.luo2english.schema);
      await setup.query(specs.luo2english.afterData);
      await setup.query("INSERT INTO users (username,email,password_hash,role) VALUES ($1,$2,$3,'admin')", ['admin', 'admin@example.test', bcrypt.hashSync('password123', 4)]);
    } finally { await setup.end(); }
    await start();
    const guest = new Client();
    const adminClient = new Client();
    const alice = new Client();
    const bob = new Client();
    assert.equal((await guest.request('/admin')).status, 302);
    assert.equal((await adminClient.post('/auth/login', { username: 'admin', password: 'password123' })).status, 302);
    assert.equal((await adminClient.post('/admin/words', { word: 'NyIng', definition: 'A name' })).status, 302);
    assert.equal((await adminClient.post('/admin/words', { word: 'nying', definition: 'duplicate' })).status, 409);
    assert.match(await (await guest.request('/?q=NAME')).text(), /nying/);
    const { rows: [word] } = await app.locals.db.query("SELECT id FROM words WHERE word='nying'");
    assert.equal((await guest.request('/word/not-a-number')).status, 404);
    for (const [client, name] of [[alice, 'alice'], [bob, 'bob']]) {
      assert.equal((await client.post('/auth/register', { username: name, email: `${name}@example.test`, password: 'password123', confirm_password: 'password123' })).status, 302);
      assert.equal((await client.request('/profile')).status, 200);
      assert.equal((await client.request('/admin')).status, 403);
    }
    const duplicate = new Client();
    assert.match(await (await duplicate.post('/auth/register', { username: 'ALICE', email: 'new@example.test', password: 'password123', confirm_password: 'password123' })).text(), /already in use/);

    assert.equal((await guest.post('/admin/words/batch', { words: 'guestword' })).status, 302);
    assert.equal((await alice.post('/admin/words/batch', { words: 'userword' })).status, 403);
    assert.equal((await adminClient.request('/admin/words/batch')).status, 200);
    const batch = await adminClient.post('/admin/words/batch', {
      words: 'Nying, BATCHWORD; (another-one)! batchword\n(another-one)'
    });
    assert.equal(batch.status, 200);
    const batchHtml = await batch.text();
    assert.match(batchHtml, /<strong>5<\/strong> words extracted/);
    assert.match(batchHtml, /<strong>3<\/strong> unique words identified/);
    assert.match(batchHtml, /<strong>1<\/strong> already in the dictionary/);
    assert.match(batchHtml, /<strong>2<\/strong> new words inserted/);
    assert.match(batchHtml, /batchword/);
    assert.match(batchHtml, /another-one/);
    const batchRows = await app.locals.db.query(
      "SELECT lower(word) AS word FROM words WHERE lower(word) = ANY($1::text[]) ORDER BY word",
      [['batchword', 'another-one']]
    );
    assert.deepEqual(batchRows.rows.map(row => row.word), ['another-one', 'batchword']);
    assert.equal((await app.locals.db.query(
      "SELECT count(*)::int AS n FROM words WHERE lower(word) IN ('batchword', 'another-one') AND trim(definition) = ''"
    )).rows[0].n, 2);

    const repeated = await adminClient.post('/admin/words/batch', {
      words: 'BATCHWORD Another-One nying'
    });
    const repeatedHtml = await repeated.text();
    assert.match(repeatedHtml, /<strong>3<\/strong> words extracted/);
    assert.match(repeatedHtml, /<strong>3<\/strong> unique words identified/);
    assert.match(repeatedHtml, /<strong>3<\/strong> already in the dictionary/);
    assert.match(repeatedHtml, /<strong>0<\/strong> new words inserted/);
    assert.equal((await app.locals.db.query(
      "SELECT count(*)::int AS n FROM words WHERE lower(word) = 'batchword'"
    )).rows[0].n, 1);

    const batchWord = (await app.locals.db.query("SELECT id FROM words WHERE word = 'batchword'")).rows[0];
    assert.equal((await adminClient.request(`/admin/words/${batchWord.id}/edit`)).status, 200);
    assert.equal((await adminClient.post(`/admin/words/${batchWord.id}`, {
      word: 'batchword', definition: 'Added later'
    })).status, 302);
    assert.equal((await app.locals.db.query(
      'SELECT definition FROM words WHERE id = $1', [batchWord.id]
    )).rows[0].definition, 'Added later');

    const attempts = await Promise.all([
      alice.json(`/comments/${word.id}`, 'POST', { body: 'first comment' }),
      alice.json(`/comments/${word.id}`, 'POST', { body: 'duplicate comment' })
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const comment = (await app.locals.db.query('SELECT id FROM comments WHERE word_id=$1', [word.id])).rows[0];
    assert.equal((await alice.json(`/comments/${comment.id}/vote`, 'POST', { value: 1 })).status, 403);
    assert.equal((await (await bob.json(`/comments/${comment.id}/vote`, 'POST', { value: 1 })).json()).action, 'added');
    assert.equal((await (await bob.json(`/comments/${comment.id}/vote`, 'POST', { value: -1 })).json()).action, 'changed');
    assert.equal((await (await bob.json(`/comments/${comment.id}/vote`, 'POST', { value: -1 })).json()).action, 'removed');
    assert.equal((await bob.json(`/comments/${comment.id}`, 'PUT', { body: 'not mine' })).status, 403);
    assert.equal((await alice.json(`/comments/${comment.id}`, 'PUT', { body: 'updated comment' })).status, 200);
    assert.match(await (await guest.request(`/word/${word.id}`)).text(), /updated comment/);
    const schemaPage = await adminClient.request('/admin/schema');
    assert.equal(schemaPage.status, 200);
    const schemaHtml = await schemaPage.text();
    assert.match(schemaHtml, /comments_one_per_word/);
    assert.match(schemaHtml, /CREATE TRIGGER/);
    await stop();
    await start();
    assert.equal((await alice.request('/profile')).status, 200);
    assert.equal((await adminClient.request('/admin')).status, 200);
    const id = (await app.locals.db.query("SELECT id FROM users WHERE username='alice'")).rows[0].id;
    const deletePage = await (await adminClient.request(`/admin/users/${id}/delete`)).text();
    const token = deletePage.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal((await adminClient.post(`/admin/users/${id}/delete`, { _csrf: token, confirm: 'delete' })).status, 302);
    assert.equal((await alice.request('/profile')).headers.get('location'), '/auth/login');
    assert.equal((await app.locals.db.query('SELECT count(*)::int AS n FROM comments WHERE id=$1', [comment.id])).rows[0].n, 0);
    assert.equal((await adminClient.post(`/admin/words/${word.id}/delete`, {})).status, 302);
    assert.equal((await guest.request(`/word/${word.id}`)).status, 404);

    const carol = new Client();
    assert.equal((await carol.post('/auth/register', {
      username: 'carol', email: 'carol@example.test', password: 'password123', confirm_password: 'password123'
    })).status, 302);
    let resetMail;
    app.locals.sendPasswordResetEmail = async payload => { resetMail = payload; return true; };
    const forgot = await new Client().post('/auth/forgot-password', { email: 'carol@example.test' });
    assert.equal(forgot.status, 200);
    assert.match(await forgot.text(), /reset link has been sent/);
    assert.equal(resetMail.to, 'carol@example.test');
    const resetToken = new URL(resetMail.resetUrl).searchParams.get('token');
    assert.ok(resetToken);
    assert.equal((await new Client().request(`/auth/reset-password?token=${resetToken}`)).status, 200);
    assert.equal((await new Client().post('/auth/reset-password', {
      token: resetToken, password: 'newpassword123', confirm_password: 'newpassword123'
    })).status, 302);
    assert.equal((await carol.request('/profile')).headers.get('location'), '/auth/login');
    const carolLogin = new Client();
    assert.equal((await carolLogin.post('/auth/login', { username: 'carol', password: 'password123' })).status, 200);
    assert.equal((await carolLogin.post('/auth/login', { username: 'carol', password: 'newpassword123' })).status, 302);
    assert.equal((await new Client().post('/auth/reset-password', {
      token: resetToken, password: 'anotherpass123', confirm_password: 'anotherpass123'
    })).status, 400);
    const unknown = await new Client().post('/auth/forgot-password', { email: 'nobody@example.test' });
    assert.equal(unknown.status, 200);
    assert.match(await unknown.text(), /reset link has been sent/);
    assert.equal((await new Client().request('/auth/forgot-password')).status, 200);
    assert.equal((await new Client().request('/auth/reset-password?token=bogus')).status, 400);
    assert.match(await (await new Client().request('/auth/login?reset=1')).text(), /password has been reset/);
  } finally {
    if (server) await stop();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
