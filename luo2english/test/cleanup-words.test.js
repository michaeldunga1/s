const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

test('Admin cleanup words feature identifies and deletes words with non-alphabetic characters', async () => {
  const url = process.env.POSTGRES_TEST_URL;
  if (!url) throw new Error('POSTGRES_TEST_URL is required');

  const schema = `luo_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  let created = false;
  let app;
  let server;
  const prior = {
    DATABASE_URL: process.env.DATABASE_URL,
    PGOPTIONS: process.env.PGOPTIONS,
    SESSION_SECRET: process.env.SESSION_SECRET
  };

  class Client {
    constructor() { this.cookie = ''; }
    async request(path, options = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        ...options,
        redirect: 'manual',
        headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) }
      });
      const cookie = response.headers.get('set-cookie');
      if (cookie) this.cookie = cookie.split(';')[0];
      return response;
    }
    post(path, values) {
      return this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values)
      });
    }
  }

  async function start() {
    for (const mod of ['../app', '../db/postgres', '../middleware/auth', '../routes/public', '../routes/auth', '../routes/comments', '../routes/admin']) {
      delete require.cache[require.resolve(mod)];
    }
    app = require('../app');
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  }

  async function stop() {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server = undefined;
    await app.locals.sessionStore.close();
    await app.locals.db.end();
    app = undefined;
  }

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`
      CREATE TABLE "${schema}".users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "${schema}".words (
        id SERIAL PRIMARY KEY,
        word TEXT UNIQUE NOT NULL,
        definition TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "${schema}".comments (
        id SERIAL PRIMARY KEY,
        word_id INTEGER NOT NULL REFERENCES "${schema}".words(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES "${schema}".users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "${schema}".votes (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER NOT NULL REFERENCES "${schema}".comments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES "${schema}".users(id) ON DELETE CASCADE,
        value INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, comment_id)
      );
    `);

    const adminHash = await bcrypt.hash('adminpass123', 10);
    const userHash = await bcrypt.hash('userpass123', 10);
    await admin.query(`
      INSERT INTO "${schema}".users (username, email, password_hash, role)
      VALUES
        ('adminuser', 'admin@example.test', '${adminHash}', 'admin'),
        ('regularuser', 'user@example.test', '${userHash}', 'user');
    `);

    // Insert sample words:
    // - Valid alphabetical: "ber", "dhano", "nyathi"
    // - Valid Dholuo words with apostrophe/hyphen: "ng'ato", "mang’ongo", "well-being"
    // - Invalid non-alphabetic words: "1kar", "26", "test_word", "hello!world"
    await admin.query(`
      INSERT INTO "${schema}".words (word, definition)
      VALUES
        ('ber', 'good'),
        ('dhano', 'human'),
        ('nyathi', 'child'),
        ('ng''ato', 'someone'),
        ('mang’ongo', 'huge'),
        ('well-being', 'health'),
        ('1kar', 'invalid 1'),
        ('26', 'invalid 2'),
        ('test_word', 'invalid 3'),
        ('hello!world', 'invalid 4');
    `);

    process.env.PGOPTIONS = `--search_path=${schema}`;
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET = 'test-secret';
    await start();

    const guest = new Client();
    const regular = new Client();
    const adminClient = new Client();

    // 1. Access Control
    assert.equal((await guest.request('/admin/words/cleanup')).status, 302);

    await regular.post('/auth/login', { username: 'regularuser', password: 'userpass123' });
    assert.equal((await regular.request('/admin/words/cleanup')).status, 403);

    await adminClient.post('/auth/login', { username: 'adminuser', password: 'adminpass123' });

    // 2. Safe mode (default)
    const cleanupSafeRes = await adminClient.request('/admin/words/cleanup');
    assert.equal(cleanupSafeRes.status, 200);
    const cleanupSafeHtml = await cleanupSafeRes.text();
    assert.match(cleanupSafeHtml, /Remove Non-Alphabetic Words/);
    assert.match(cleanupSafeHtml, /4 words flagged for removal/);
    assert.match(cleanupSafeHtml, /1kar/);
    assert.match(cleanupSafeHtml, /test_word/);
    assert.match(cleanupSafeHtml, /hello!world/);
    assert.match(cleanupSafeHtml, /26/);
    // Safe mode should not flag ng'ato or mang’ongo or well-being
    assert.doesNotMatch(cleanupSafeHtml, /<strong>ng'ato<\/strong>/);
    assert.doesNotMatch(cleanupSafeHtml, /<strong>mang’ongo<\/strong>/);

    // 3. Strict mode
    const cleanupStrictRes = await adminClient.request('/admin/words/cleanup?mode=strict');
    assert.equal(cleanupStrictRes.status, 200);
    const cleanupStrictHtml = await cleanupStrictRes.text();
    // Strict mode flags the 4 dirty words + 3 words with apostrophe/hyphen = 7
    assert.match(cleanupStrictHtml, /7 words flagged for removal/);
    assert.match(cleanupStrictHtml, /ng(&#39;|')ato/);

    // Extract CSRF token
    const tokenMatch = cleanupSafeHtml.match(/name="_csrf" value="([a-f0-9]{64})"/);
    assert.ok(tokenMatch, 'CSRF token must be present');
    const csrfToken = tokenMatch[1];

    // 4. CSRF protection on POST
    const fakePost = await adminClient.post('/admin/words/cleanup', { _csrf: 'invalid', mode: 'safe' });
    assert.equal(fakePost.status, 403);

    // 5. Delete in safe mode
    const deleteRes = await adminClient.post('/admin/words/cleanup', { _csrf: csrfToken, mode: 'safe' });
    assert.equal(deleteRes.status, 302);
    assert.equal(deleteRes.headers.get('location'), '/admin/words/cleanup?mode=safe');

    // Verify database state after deletion
    const remainingWords = (await app.locals.db.query('SELECT word FROM words ORDER BY word ASC')).rows.map(r => r.word);
    assert.deepEqual(remainingWords, ['ber', 'dhano', "mang’ongo", "ng'ato", 'nyathi', 'well-being']);

    // Check cleanup page shows 0 words under safe mode
    const afterDeleteRes = await adminClient.request('/admin/words/cleanup?mode=safe');
    const afterDeleteHtml = await afterDeleteRes.text();
    assert.match(afterDeleteHtml, /No words containing non-alphabetic characters found/);
    assert.match(afterDeleteHtml, /Successfully removed 4 words/);

    // 6. Delete in strict mode to remove remaining words with apostrophes/hyphens
    const strictCleanupRes = await adminClient.request('/admin/words/cleanup?mode=strict');
    const strictCleanupHtml = await strictCleanupRes.text();
    const strictTokenMatch = strictCleanupHtml.match(/name="_csrf" value="([a-f0-9]{64})"/);
    assert.ok(strictTokenMatch, 'CSRF token must be present on strict cleanup page');
    const strictDeleteRes = await adminClient.post('/admin/words/cleanup', { _csrf: strictTokenMatch[1], mode: 'strict' });
    assert.equal(strictDeleteRes.status, 302);

    const finalWords = (await app.locals.db.query('SELECT word FROM words ORDER BY word ASC')).rows.map(r => r.word);
    assert.deepEqual(finalWords, ['ber', 'dhano', 'nyathi']);

  } finally {
    if (server) await stop();
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
