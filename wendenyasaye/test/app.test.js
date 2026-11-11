const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool, types } = require('pg');
const { schema } = require('../scripts/export-postgres');

types.setTypeParser(20, value => Number(value));
const namespace = `wende_routes_test_${crypto.randomBytes(8).toString('hex')}`;
let db;
let adminPool;
let app;
let schemaCreated = false;

function sqlParameters(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
async function get(sql, values = []) {
  return (await db.query(sqlParameters(sql), values)).rows[0];
}
async function all(sql, values = []) {
  return (await db.query(sqlParameters(sql), values)).rows;
}
async function insertId(sql) {
  return (await db.query(`${sql} RETURNING id`)).rows[0].id;
}

let server;
let base;
class Client {
  constructor() { this.cookie = ''; }
  async request(url, options = {}) {
    const response = await fetch(base + url, {
      ...options,
      redirect: 'manual',
      headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) }
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return response;
  }
  async token(url = '/') {
    const response = await this.request(url);
    const html = await response.text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, `Expected a CSRF token on ${url} (status ${response.status}, location ${response.headers.get('location')})`);
    return match[1];
  }
  async post(url, values, token) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...values, _csrf: token })) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
    }
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
  }
  async login(email, password) {
    const token = await this.token('/login');
    return this.post('/login', { email, password }, token);
  }
}

test.before(async () => {
  if (!process.env.POSTGRES_TEST_URL) throw new Error('POSTGRES_TEST_URL is required for route tests');
  adminPool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await adminPool.query(`CREATE SCHEMA "${namespace}"`);
  schemaCreated = true;
  process.env.DATABASE_URL = process.env.POSTGRES_TEST_URL;
  process.env.PGOPTIONS = `-c search_path=${namespace},pg_catalog`;
  db = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await db.query(schema);
  await db.query("INSERT INTO categories (name) VALUES ('Praise'), ('Worship'), ('Prayer'), ('Thanksgiving'), ('Christmas'), ('Easter'), ('Faith'), ('Hope'), ('Service'), ('Sabbath')");
  await db.query('INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)', ['admin@example.com', 'admin@example.com', bcrypt.hashSync('password123', 4), 'admin']);
  app = require('../app');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (app) {
    await app.locals.sessionStore.close();
    await app.locals.repository.close();
  }
  if (db) await db.end();
  if (adminPool) {
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await adminPool.end();
  }
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
  assert.match(home, /aria-hidden="true"><use href="\/icons.svg#music"/);
  for (const link of ['/privacy', '/terms', '/cookies']) assert.ok(home.includes(`href="${link}"`));
  const privacy = await (await guest.request('/privacy')).text();
  assert.match(privacy, /Contabo/);
  assert.match(privacy, /favorites.*bookmarks/i);
  assert.match(await (await guest.request('/cookies')).text(), /service worker/i);
});

test('new directory is empty and public', async () => {
  const client = new Client();
  const response = await client.request('/api/hymns');
  const hymns = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(hymns, []);
});

test('registration saves the session before redirecting', async () => {
  const client = new Client();
  const token = await client.token('/register');
  const store = app.locals.sessionStore;
  const originalSet = store.set;
  let saved = false;
  store.set = function (sid, session, callback) {
    setTimeout(() => originalSet.call(this, sid, session, error => {
      saved = !error;
      callback(error);
    }), 50);
  };
  try {
    const response = await client.post('/register', { email: 'session-save@example.com', password: 'password123' }, token);
    assert.equal(response.status, 302);
    assert.equal(saved, true);
    assert.equal((await client.request('/profile')).status, 200);
  } finally {
    store.set = originalSet;
  }
});

test('admin access, validation, creation, editing and deletion', async () => {
  const guest = new Client();
  assert.equal((await guest.request('/admin')).status, 302);
  const admin = new Client();
  assert.equal((await admin.login('ADMIN@example.com', 'password123')).status, 302);
  const homepage = await (await admin.request('/')).text();
  assert.match(homepage, /href="\/admin">Admin<\/a>/);
  let token = await admin.token('/admin/hymns/new');
  const values = { title: 'Test hymn', number: '42', lyrics: 'First verse\n\nSecond verse', author: 'A Composer' };
  assert.equal((await admin.post('/admin/hymns/new', { ...values, lyrics: '  ' }, token)).status, 400);
  assert.equal((await admin.post('/admin/hymns/new', values, 'bad-token')).status, 403);
  assert.equal((await admin.post('/admin/hymns/new', values, token)).status, 302);
  const hymn = (await get('SELECT * FROM hymns WHERE number = 42', []));
  assert.ok(hymn);
  assert.equal(hymn.lyrics, values.lyrics);
  const page = await (await admin.request(`/hymns/${hymn.slug}`)).text();
  assert.match(page, /First verse\n\nSecond verse/);
  assert.match(page, /By <a[^>]*>A Composer<\/a>/);
  token = await admin.token(`/admin/hymns/${hymn.id}/edit`);
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/edit`, { ...values, title: 'Edited hymn' }, token)).status, 302);
  assert.equal((await get('SELECT title FROM hymns WHERE id = ?', [hymn.id])).title, 'Edited hymn');
  assert.equal((await admin.post('/admin/hymns/new', values, token)).status, 409);
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/delete`, {}, token)).status, 302);
  assert.equal((await get('SELECT id FROM hymns WHERE id = ?', [hymn.id])), undefined);
});

test('registered users can manage their own favorites but cannot administer hymns', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const adminToken = await admin.token('/admin/hymns/new');
  const values = { title: 'Favorite hymn', number: '1', lyrics: 'One verse', author: '' };
  assert.equal((await admin.post('/admin/hymns/new', values, adminToken)).status, 302);
  const alice = new Client();
  let token = await alice.token('/register');
  assert.equal((await alice.post('/register', { email: 'alice@example.com', password: 'password123' }, token)).status, 302);
  assert.equal((await alice.request('/admin')).status, 403);
  assert.doesNotMatch(await (await alice.request('/')).text(), /href="\/admin">Admin<\/a>/);
  token = await alice.token('/');
  assert.equal((await alice.post('/admin/hymns/new', values, token)).status, 403);
  const hymn = (await get('SELECT id FROM hymns LIMIT 1', []));
  assert.equal((await alice.post(`/favorites/${hymn.id}`, { action: 'add' }, token)).status, 302);
  assert.match(await (await alice.request('/')).text(), /data-favorite="true"/);
  const bob = new Client();
  token = await bob.token('/register');
  assert.equal((await bob.post('/register', { email: 'bob@example.com', password: 'password123' }, token)).status, 302);
  assert.match(await (await bob.request('/')).text(), /data-favorite="false"/);
  token = await alice.token('/');
  assert.equal((await alice.post(`/favorites/${hymn.id}`, { action: 'remove' }, token)).status, 302);
  assert.match(await (await alice.request('/')).text(), /data-favorite="false"/);
});

test('authors are shared, lyrics are escaped and the public API contains complete hymns', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/hymns/new');
  const base = { lyrics: 'First line\n<script>alert(1)</script>', author: 'Shared Author' };
  assert.equal((await admin.post('/admin/hymns/new', { ...base, title: 'First song', number: '10' }, token)).status, 302);
  assert.equal((await admin.post('/admin/hymns/new', { ...base, author: 'shared author', title: 'Second song', number: '11' }, token)).status, 302);
  const authors = (await all('SELECT id FROM authors WHERE lower(name) = lower(?)', ['shared author']));
  assert.equal(authors.length, 1);
  assert.equal((await get('SELECT count(*) AS count FROM hymns WHERE author_id = ?', [authors[0].id])).count, 2);
  const hymn = (await get('SELECT id, slug FROM hymns WHERE number = 10', []));
  const html = await (await admin.request(`/hymns/${hymn.slug}`)).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const data = await (await admin.request('/api/hymns')).json();
  assert.equal(data.find(item => item.id === hymn.id).lyrics, base.lyrics);
  assert.equal(data.find(item => item.id === hymn.id).author, 'Shared Author');
});

test('composer and page metadata can be saved, displayed and edited for lyric placeholders', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/hymns/new');
  const values = { title: 'Metadata hymn', number: '70', lyrics: 'A verse', author: 'Writer', composer: 'Composer A; Composer B', page_number: '15' };
  assert.equal((await admin.post('/admin/hymns/new', { ...values, page_number: '0' }, token)).status, 400);
  assert.equal((await admin.post('/admin/hymns/new', values, token)).status, 302);
  const hymn = (await get('SELECT * FROM hymns WHERE number = 70', []));
  assert.equal(hymn.composer, values.composer);
  assert.equal(hymn.page_number, 15);
  const html = await (await admin.request(`/hymns/${hymn.slug}`)).text();
  assert.match(html, /Composer: <a[^>]*>Composer A<\/a>; <a[^>]*>Composer B<\/a>/);
  assert.match(html, /Page 15/);
  assert.match(html, /By <a[^>]*>Writer<\/a>/);
  const api = await (await admin.request('/api/hymns')).json();
  assert.equal(api.find(item => item.id === hymn.id).composer, values.composer);
  assert.equal(api.find(item => item.id === hymn.id).page_number, 15);
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/edit`, { ...values, lyrics: '' }, token)).status, 400);
  const id = (await insertId("INSERT INTO hymns (number, title, lyrics, composer, slug) VALUES (71, 'Placeholder', '', 'A Composer', 'placeholder')"));
  assert.equal((await admin.post(`/admin/hymns/${id}/edit`, { title: 'Placeholder', number: '71', lyrics: '', author: '', composer: 'New composer', page_number: '5' }, token)).status, 302);
  assert.deepEqual((await get('SELECT lyrics, composer, page_number FROM hymns WHERE id = ?', [id])), { lyrics: '', composer: 'New composer', page_number: 5 });
});

test('registration validates and deduplicates emails case-insensitively', async () => {
  const client = new Client();
  const token = await client.token('/register');
  assert.equal((await client.post('/register', { email: 'not-an-email', password: 'password123' }, token)).status, 400);
  assert.equal((await client.post('/register', { email: 'ALICE@EXAMPLE.COM', password: 'password123' }, token)).status, 409);
  assert.equal((await client.login('alice@example.com', 'wrongpassword')).status, 401);
  assert.equal((await client.login('Alice@Example.com', 'password123')).status, 302);
});

test('signed-in users and admins can access their profile from the navbar', async () => {
  const guest = new Client();
  assert.equal((await guest.request('/profile')).headers.get('location'), '/login');
  assert.doesNotMatch(await (await guest.request('/')).text(), /href="\/profile">Profile/);
  const user = new Client();
  await user.login('alice@example.com', 'password123');
  const home = await (await user.request('/')).text();
  assert.match(home, /href="\/profile">Profile<\/a>/);
  assert.doesNotMatch(home, /alice@example\.com/);
  const profile = await (await user.request('/profile')).text();
  assert.match(profile, /alice@example\.com/);
  assert.match(profile, /Account type:<\/strong> User/);
  assert.doesNotMatch(profile, /bob@example\.com/);
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const adminProfile = await (await admin.request('/profile')).text();
  assert.match(adminProfile, /admin@example\.com/);
  assert.match(adminProfile, /Account type:<\/strong> Administrator/);
  assert.match(adminProfile, /href="\/admin">Admin<\/a>/);
});

test('only admins list and delete users, and deletion invalidates sessions and saved items', async () => {
  const guest = new Client();
  assert.doesNotMatch(await (await guest.request('/')).text(), /href="\/admin\/users">Users/);
  assert.equal((await guest.request('/admin/users')).status, 302);
  const user = new Client();
  let token = await user.token('/register');
  await user.post('/register', { email: 'delete@example.com', password: 'password123' }, token);
  const account = (await get("SELECT id FROM users WHERE email = 'delete@example.com'", []));
  const hymn = (await get('SELECT id FROM hymns LIMIT 1', []));
  token = await user.token('/');
  await user.post(`/favorites/${hymn.id}`, { action: 'add' }, token);
  await user.post(`/bookmarks/${hymn.id}`, { action: 'add' }, token);
  assert.doesNotMatch(await (await user.request('/')).text(), /href="\/admin\/users">Users/);
  assert.equal((await user.request('/admin/users')).status, 403);
  assert.equal((await user.post(`/admin/users/${account.id}/delete`, { confirm: 'delete' }, token)).status, 403);
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const html = await (await admin.request('/admin/users')).text();
  assert.match(html, /href="\/admin\/users">Users/);
  assert.match(html, /delete@example.com/);
  assert.match(html, /admin@example.com/);
  assert.doesNotMatch(html, /aria-label="Delete admin@example.com"/);
  const confirm = await (await admin.request(`/admin/users/${account.id}/delete`)).text();
  const csrf = confirm.match(/name="_csrf" value="([^"]+)"/)[1];
  const accountToken = confirm.match(/name="accountToken" value="([^"]+)"/)[1];
  assert.equal((await admin.post(`/admin/users/${account.id}/delete`, { accountToken, confirm: 'delete' }, 'bad')).status, 403);
  assert.equal((await admin.post(`/admin/users/${account.id}/delete`, { accountToken }, csrf)).status, 400);
  assert.equal((await admin.post(`/admin/users/${account.id}/delete`, { accountToken: 'invalid', confirm: 'delete' }, csrf)).status, 409);
  const adminId = (await get("SELECT id FROM users WHERE role = 'admin'", [])).id;
  assert.equal((await admin.post(`/admin/users/${adminId}/delete`, { accountToken, confirm: 'delete' }, csrf)).status, 404);
  assert.equal((await admin.post(`/admin/users/${account.id}/delete`, { accountToken, confirm: 'delete' }, csrf)).status, 302);
  assert.equal((await get('SELECT id FROM users WHERE id = ?', [account.id])), undefined);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE user_id = ?', [account.id])).n, 0);
  assert.equal((await get('SELECT count(*) n FROM bookmarks WHERE user_id = ?', [account.id])).n, 0);
  const replacement = new Client();
  token = await replacement.token('/register');
  await replacement.post('/register', { email: 'replacement@example.com', password: 'password123' }, token);
  await db.query("UPDATE users SET id = $1 WHERE email = 'replacement@example.com'", [account.id]);
  assert.equal((await get("SELECT id FROM users WHERE email = 'replacement@example.com'", [])).id, account.id);
  assert.equal((await user.request('/api/hymns')).status, 401);
  assert.equal((await user.request('/')).headers.get('location'), '/?signed_out=1');
  assert.equal((await admin.post(`/admin/users/${account.id}/delete`, { accountToken, confirm: 'delete' }, csrf)).status, 409);
});

test('hymn details provide admin controls, sharing and private bookmarks distinct from favorites', async () => {
  const hymnId = (await insertId("INSERT INTO hymns (title, lyrics, slug) VALUES ('Bookmark test hymn', 'Lyrics', 'bookmark-test-hymn')"));
  const page = '/hymns/bookmark-test-hymn';
  const guest = new Client();
  const guestPage = await (await guest.request(page)).text();
  assert.match(guestPage, /Sign in to bookmark/);
  assert.match(guestPage, /Share hymn/);
  assert.match(guestPage, new RegExp(`href="${page}">Hymn link`));
  assert.doesNotMatch(guestPage, /\/admin\/hymns\/\d+\/(?:edit|delete)/);
  assert.equal((await guest.request(`/admin/hymns/${hymnId}/delete`)).headers.get('location'), '/login');
  const alice = new Client();
  const bob = new Client();
  await alice.login('alice@example.com', 'password123');
  await bob.login('bob@example.com', 'password123');
  const token = await alice.token(page);
  assert.match(await (await alice.request(page)).text(), /Bookmark<\/button>/);
  assert.equal((await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, 'bad')).status, 403);
  assert.equal((await alice.post(`/bookmarks/${hymnId}`, { action: 'bad' }, token)).status, 400);
  assert.equal((await alice.post('/bookmarks/999999', { action: 'add' }, token)).status, 404);
  assert.equal((await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, token)).headers.get('location'), page);
  assert.equal((await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM bookmarks WHERE hymn_id = ?', [hymnId])).n, 1);
  assert.match(await (await alice.request(page)).text(), /Remove bookmark/);
  assert.match(await (await alice.request('/profile')).text(), /Bookmark test hymn/);
  assert.doesNotMatch(await (await bob.request('/profile')).text(), /Bookmark test hymn/);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE hymn_id = ?', [hymnId])).n, 0);
  assert.equal((await alice.post(`/admin/hymns/${hymnId}/delete`, {}, token)).status, 403);
  assert.equal((await alice.request(`/admin/hymns/${hymnId}/edit`)).status, 403);
  assert.equal((await alice.post(`/admin/hymns/${hymnId}/edit`, { title: 'Unauthorized', lyrics: 'Changed' }, token)).status, 403);
  assert.equal((await get('SELECT title FROM hymns WHERE id = ?', [hymnId])).title, 'Bookmark test hymn');
  const removed = await alice.post(`/bookmarks/${hymnId}`, { action: 'remove', from: 'profile' }, token);
  assert.equal(removed.headers.get('location'), '/profile');
  assert.doesNotMatch(await (await alice.request('/profile')).text(), /Bookmark test hymn/);
  await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, token);
  await alice.post(`/favorites/${hymnId}`, { action: 'add' }, token);
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const adminPage = await (await admin.request(page)).text();
  assert.match(adminPage, new RegExp(`/admin/hymns/${hymnId}/edit`));
  assert.match(adminPage, new RegExp(`/admin/hymns/${hymnId}/delete`));
  const confirm = await (await admin.request(`/admin/hymns/${hymnId}/delete`)).text();
  assert.match(confirm, /favorites and bookmarks/);
  const csrf = confirm.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await admin.post(`/admin/hymns/${hymnId}/delete`, {}, 'bad')).status, 403);
  assert.equal((await admin.post(`/admin/hymns/${hymnId}/delete`, {}, csrf)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM bookmarks WHERE hymn_id = ?', [hymnId])).n, 0);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE hymn_id = ?', [hymnId])).n, 0);
  assert.equal((await alice.request(page)).status, 404);
});

test('bookmark notes and tags are private, editable and validated', async () => {
  const hymnId = (await insertId("INSERT INTO hymns (title, lyrics, slug) VALUES ('Annotated hymn', 'Lyrics', 'annotated-hymn')"));
  const edit = `/bookmarks/${hymnId}/edit`;
  const hymnPage = '/hymns/annotated-hymn';
  const alice = new Client();
  const bob = new Client();
  const guest = new Client();
  await alice.login('alice@example.com', 'password123');
  await bob.login('bob@example.com', 'password123');
  assert.equal((await guest.request(edit)).headers.get('location'), '/login');
  assert.equal((await alice.request(edit)).status, 404);
  const token = await alice.token(hymnPage);
  await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, token);
  assert.match(await (await alice.request(hymnPage)).text(), new RegExp(`href="${edit}"`));
  assert.match(await (await alice.request('/profile')).text(), new RegExp(`href="${edit}"`));
  assert.equal((await bob.request(edit)).status, 404);
  const bobToken = await bob.token(hymnPage);
  assert.equal((await bob.post(edit, { note: 'intrusion', tags: '' }, bobToken)).status, 404);
  assert.equal((await alice.post(edit, { note: 'note', tags: 'tag' }, 'bad')).status, 403);
  const invalid = await alice.post(edit, { note: 'n'.repeat(5001), tags: 'tag' }, token);
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /5,000 characters/);
  assert.equal((await alice.post(edit, { note: '', tags: 't'.repeat(501) }, token)).status, 400);
  assert.equal((await alice.post(edit, { note: 'missing tags' }, token)).status, 400);
  const note = 'First line\n<script>alert(1)</script>';
  const tags = 'worship, <hope>';
  assert.equal((await alice.post(edit, { note, tags }, token)).headers.get('location'), '/profile');
  await alice.post(`/bookmarks/${hymnId}`, { action: 'add' }, token);
  const profile = await (await alice.request('/profile')).text();
  assert.match(profile, /First line\n&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(profile, /worship, &lt;hope&gt;/);
  assert.match(await (await alice.request(hymnPage)).text(), /First line/);
  assert.doesNotMatch(await (await bob.request(hymnPage)).text(), /First line|worship, &lt;hope&gt;/);
  assert.doesNotMatch(await (await guest.request(hymnPage)).text(), /First line/);
  await bob.post(`/bookmarks/${hymnId}`, { action: 'add' }, bobToken);
  await bob.post(edit, { note: 'Bob private', tags: 'other' }, bobToken);
  assert.doesNotMatch(await (await alice.request('/profile')).text(), /Bob private/);
  assert.match(await (await bob.request('/profile')).text(), /Bob private/);
  assert.equal((await alice.post(edit, { note: 'n'.repeat(5000), tags: 't'.repeat(500) }, token)).status, 302);
  assert.equal((await alice.post(edit, { note: '', tags: '' }, token)).status, 302);
  const aliceId = (await get("SELECT id FROM users WHERE email = 'alice@example.com'", [])).id;
  assert.deepEqual((await get('SELECT note, tags FROM bookmarks WHERE user_id = ? AND hymn_id = ?', [aliceId, hymnId])), { note: '', tags: '' });
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE hymn_id = ?', [hymnId])).n, 0);
});

test('users can change their own email and delete their account with confirmation', async () => {
  const guest = new Client();
  assert.equal((await guest.request('/profile/edit')).headers.get('location'), '/login');
  assert.equal((await guest.request('/profile/delete')).headers.get('location'), '/login');
  const user = new Client();
  let token = await user.token('/register');
  await user.post('/register', { email: 'self@example.com', password: 'password123' }, token);
  const userId = (await get("SELECT id FROM users WHERE email = 'self@example.com'", [])).id;
  const otherSession = new Client();
  await otherSession.login('self@example.com', 'password123');
  const hymn = (await get('SELECT id FROM hymns LIMIT 1', []));
  token = await user.token('/profile');
  await user.post(`/bookmarks/${hymn.id}`, { action: 'add' }, token);
  await user.post(`/bookmarks/${hymn.id}/edit`, { note: 'My note', tags: 'my tag' }, token);
  await user.post(`/favorites/${hymn.id}`, { action: 'add' }, token);
  const profile = await (await user.request('/profile')).text();
  assert.match(profile, /href="\/profile\/edit"/);
  assert.match(profile, /href="\/profile\/delete"/);
  assert.equal((await user.post('/profile/edit', { email: 'changed@example.com', password: 'password123' }, 'bad')).status, 403);
  assert.equal((await user.post('/profile/edit', { email: 'bad email', password: 'password123' }, token)).status, 400);
  assert.equal((await user.post('/profile/edit', { email: 'changed@example.com', password: 'wrong' }, token)).status, 400);
  assert.equal((await user.post('/profile/edit', { email: 'ALICE@example.com', password: 'password123' }, token)).status, 409);
  assert.equal((await user.post('/profile/edit', { email: ' Changed@Example.com ', password: 'password123', role: 'admin', id: '1' }, token)).headers.get('location'), '/profile');
  assert.deepEqual((await get('SELECT email, username, role FROM users WHERE id = ?', [userId])), { email: 'changed@example.com', username: 'changed@example.com', role: 'user' });
  assert.match(await (await otherSession.request('/profile')).text(), /changed@example.com/);
  assert.equal((await user.post('/profile/delete', { password: 'password123', confirm: 'delete' }, 'bad')).status, 403);
  assert.equal((await user.post('/profile/delete', { password: 'wrong', confirm: 'delete' }, token)).status, 400);
  assert.equal((await user.post('/profile/delete', { password: 'password123' }, token)).status, 400);
  assert.ok((await get('SELECT id FROM users WHERE id = ?', [userId])));
  assert.equal((await user.post('/profile/delete', { password: 'password123', confirm: 'delete', id: '1' }, token)).headers.get('location'), '/?signed_out=1');
  assert.equal((await get('SELECT id FROM users WHERE id = ?', [userId])), undefined);
  assert.equal((await get('SELECT count(*) n FROM bookmarks WHERE user_id = ?', [userId])).n, 0);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE user_id = ?', [userId])).n, 0);
  assert.ok((await get("SELECT id FROM users WHERE email = 'admin@example.com'", [])));
  assert.equal((await otherSession.request('/api/hymns')).status, 401);
  assert.equal((await otherSession.request('/profile')).headers.get('location'), '/?signed_out=1');
  const admin = new Client();
  assert.equal((await admin.login('admin@example.com', 'password123')).headers.get('location'), '/');
  const adminToken = await admin.token('/profile');
  assert.doesNotMatch(await (await admin.request('/profile')).text(), /href="\/profile\/delete"/);
  assert.equal((await admin.request('/profile/delete')).status, 403);
  assert.equal((await admin.post('/profile/delete', { password: 'password123', confirm: 'delete' }, adminToken)).status, 403);
});

test('self and admin deletion remove saved favorites', async () => {
  const hymn = (await get('SELECT id FROM hymns LIMIT 1', []));
  const self = new Client();
  let token = await self.token('/register');
  await self.post('/register', { email: 'legacy-self@example.com', password: 'password123' }, token);
  const selfId = (await get("SELECT id FROM users WHERE email = 'legacy-self@example.com'", [])).id;
  token = await self.token('/profile');
  await self.post(`/favorites/${hymn.id}`, { action: 'add' }, token);
  assert.equal((await self.post('/profile/delete', { password: 'password123', confirm: 'delete' }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE user_id = ?', [selfId])).n, 0);
  const target = new Client();
  token = await target.token('/register');
  await target.post('/register', { email: 'legacy-admin-target@example.com', password: 'password123' }, token);
  const id = (await get("SELECT id FROM users WHERE email = 'legacy-admin-target@example.com'", [])).id;
  token = await target.token('/');
  await target.post(`/favorites/${hymn.id}`, { action: 'add' }, token);
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const html = await (await admin.request(`/admin/users/${id}/delete`)).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const accountToken = html.match(/name="accountToken" value="([^"]+)"/)[1];
  assert.equal((await admin.post(`/admin/users/${id}/delete`, { accountToken, confirm: 'delete' }, csrf)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM favorites WHERE user_id = ?', [id])).n, 0);
});

test('hymn slugs are unique, stable, canonical and preserve numeric links', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/hymns/new');
  const create = title => admin.post('/admin/hymns/new', { title, lyrics: 'Verse' }, token);
  assert.equal((await create("Jalʼs Song")).status, 302);
  assert.equal((await create("Jal's Song!")).status, 302);
  assert.equal((await create('123')).status, 302);
  assert.equal((await create('!!!')).status, 302);
  assert.equal((await create('你好')).status, 302);
  const first = (await get('SELECT id, slug FROM hymns WHERE title = ?', ["Jalʼs Song"]));
  assert.equal(first.slug, 'jals-song');
  assert.equal((await get('SELECT slug FROM hymns WHERE title = ?', ["Jal's Song!"])).slug, 'jals-song-2');
  assert.equal((await get("SELECT slug FROM hymns WHERE title = '123'", [])).slug, 'hymn-123');
  assert.equal((await get("SELECT slug FROM hymns WHERE title = '!!!'", [])).slug, 'hymn');
  const guest = new Client();
  const numeric = await guest.request(`/hymns/${first.id}`);
  assert.equal(numeric.status, 302);
  assert.equal(numeric.headers.get('location'), '/hymns/jals-song');
  assert.equal((await guest.request('/hymns/999999999')).status, 404);
  assert.equal((await guest.request('/hymns/no-such-hymn')).status, 404);
  const index = await (await guest.request('/')).text();
  assert.match(index, /href="\/hymns\/jals-song"/);
  assert.match(index, /href="\/hymns\/%E4%BD%A0%E5%A5%BD"/);
  assert.equal((await guest.request('/hymns/%E4%BD%A0%E5%A5%BD')).status, 200);
  assert.match(await (await guest.request('/hymns/jals-song')).text(), /href="\/hymns\/jals-song">Hymn link/);
  assert.equal((await admin.post(`/admin/hymns/${first.id}/edit`, { title: 'Changed title', lyrics: 'Verse' }, token)).status, 302);
  assert.equal((await get('SELECT slug FROM hymns WHERE id = ?', [first.id])).slug, 'jals-song');
  assert.match(await (await guest.request('/hymns/jals-song')).text(), /Changed title/);
  const api = await (await guest.request('/api/hymns')).json();
  assert.equal(api.find(hymn => hymn.id === first.id).slug, 'jals-song');
  await assert.rejects(db.query("INSERT INTO hymns (title, lyrics) VALUES ('No slug', '')"), { code: '23502' });
  await assert.rejects(db.query("INSERT INTO hymns (title, lyrics, slug) VALUES ('Numeric slug', '', '123')"), { code: '23514' });
  await assert.rejects(db.query("INSERT INTO hymns (title, lyrics, slug) VALUES ('Duplicate slug', '', 'jals-song')"), { code: '23505' });
});

test('admins manage categories and assign multiple categories to hymns', async () => {
  const guest = new Client();
  assert.equal((await guest.request('/admin/categories')).headers.get('location'), '/login');
  const user = new Client();
  await user.login('alice@example.com', 'password123');
  const userToken = await user.token('/');
  assert.equal((await user.request('/admin/categories')).status, 403);
  assert.equal((await user.post('/admin/categories', { name: 'Unauthorized' }, userToken)).status, 403);
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/categories');
  assert.equal((await admin.post('/admin/categories', { name: 'New category' }, 'bad')).status, 403);
  assert.equal((await admin.post('/admin/categories', { name: '  ' }, token)).status, 400);
  assert.equal((await admin.post('/admin/categories', { name: 'pRAISe' }, token)).status, 409);
  assert.equal((await admin.post('/admin/categories', { name: 'New category' }, token)).status, 302);
  const category = (await get("SELECT id FROM categories WHERE name = 'New category'", []));
  const praise = (await get("SELECT id FROM categories WHERE name = 'Praise'", []));
  assert.equal((await admin.post(`/admin/categories/${category.id}/edit`, { name: 'worship' }, token)).status, 409);
  assert.equal((await admin.post(`/admin/categories/${category.id}/edit`, { name: 'Mission' }, token)).status, 302);
  const values = { title: 'Categorized hymn', lyrics: 'Verse', categories: [String(category.id), String(praise.id)] };
  assert.equal((await admin.post('/admin/hymns/new', values, token)).status, 302);
  const hymn = (await get("SELECT id, slug FROM hymns WHERE title = 'Categorized hymn'", []));
  const api = await (await guest.request('/api/hymns')).json();
  assert.deepEqual(api.find(item => item.id === hymn.id).categories.map(item => item.name), ['Mission', 'Praise']);
  const page = await (await guest.request(`/hymns/${hymn.slug}`)).text();
  assert.match(page, /Categories:/);
  assert.match(page, new RegExp(`href="/\\?category=${category.id}">Mission`));
  assert.match(await (await guest.request(`/?category=${category.id}`)).text(), /Categorized hymn/);
  assert.doesNotMatch(await (await guest.request(`/?category=${category.id}`)).text(), /Annotated hymn/);
  assert.equal((await guest.request('/?category=999999')).status, 404);
  const form = await (await admin.request(`/admin/hymns/${hymn.id}/edit`)).text();
  assert.match(form, new RegExp(`value="${category.id}" checked`));
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/edit`, { ...values, title: 'Rejected', categories: ['999999'] }, token)).status, 400);
  assert.equal((await get('SELECT title FROM hymns WHERE id = ?', [hymn.id])).title, 'Categorized hymn');
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/edit`, { ...values, categories: [String(praise.id)] }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM hymn_categories WHERE hymn_id = ?', [hymn.id])).n, 1);
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/edit`, { ...values, categories: [] }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM hymn_categories WHERE hymn_id = ?', [hymn.id])).n, 0);
  await admin.post(`/admin/hymns/${hymn.id}/edit`, values, token);
  assert.equal((await user.post(`/admin/categories/${category.id}/delete`, { confirm: 'delete' }, userToken)).status, 403);
  assert.equal((await admin.post(`/admin/categories/${category.id}/delete`, {}, token)).status, 400);
  assert.equal((await admin.post(`/admin/categories/${category.id}/delete`, { confirm: 'delete' }, 'bad')).status, 403);
  assert.equal((await admin.post(`/admin/categories/${category.id}/delete`, { confirm: 'delete' }, token)).status, 302);
  assert.ok((await get('SELECT id FROM hymns WHERE id = ?', [hymn.id])));
  assert.equal((await get('SELECT count(*) n FROM hymn_categories WHERE category_id = ?', [category.id])).n, 0);
  assert.equal((await get('SELECT count(*) n FROM hymn_categories WHERE hymn_id = ?', [hymn.id])).n, 1);
  assert.equal((await admin.post(`/admin/hymns/${hymn.id}/delete`, {}, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM hymn_categories WHERE hymn_id = ?', [hymn.id])).n, 0);
});

test('hymn search finds lyrics and metadata with category filters', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/hymns/new');
  const praise = (await get("SELECT id FROM categories WHERE name = 'Praise'", [])).id;
  const hymn = { title: 'Searchable hymn', lyrics: 'A unique lyric <phrase>', author: 'Distinct Author', composer: 'Special Composer', page_number: '234', categories: String(praise) };
  await admin.post('/admin/hymns/new', hymn, token);
  const guest = new Client();
  for (const q of ['UNIQUE LYRIC', 'distinct author', 'special composer', '234', 'praise', 'searchable']) {
    const response = await guest.request(`/?category=${praise}&q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Searchable hymn/);
  }
  const html = await (await guest.request('/?q=unique%20lyric')).text();
  assert.match(html, /&lt;phrase&gt;/);
  assert.match(html, /name="q"/);
  assert.match(await (await guest.request('/?q=no-match')).text(), /No hymns found/);
  assert.equal((await guest.request('/?q=a&q=b')).status, 400);
  assert.equal((await guest.request(`/?q=${'x'.repeat(201)}`)).status, 400);
});

test('composer, category and lyric author links lead to exact hymn collections', async () => {
  const admin = new Client();
  await admin.login('admin@example.com', 'password123');
  const token = await admin.token('/admin/hymns/new');
  const praise = (await get("SELECT id FROM categories WHERE name = 'Praise'", [])).id;
  const values = { lyrics: 'Verse', author: 'Distinct Lyricist', categories: String(praise) };
  await admin.post('/admin/hymns/new', { ...values, title: 'Credit One', composer: 'Alice & Co; Bob Jones' }, token);
  await admin.post('/admin/hymns/new', { ...values, title: 'Credit Two', composer: 'bob jones; Carol' }, token);
  await admin.post('/admin/hymns/new', { ...values, title: 'Credit Three', composer: 'Bob Jones Jr.' }, token);
  const guest = new Client();
  const home = await (await guest.request('/')).text();
  assert.match(home, /href="\/composers">Composers/);
  assert.match(home, /href="\/categories">Categories/);
  assert.match(home, /href="\/composers\?name=Alice%20%26%20Co">Alice &amp; Co<\/a>/);
  const directories = await (await guest.request('/composers')).text();
  assert.match(directories, /Bob Jones<\/a>/);
  assert.match(directories, /2 hymns/);
  assert.match(await (await guest.request('/categories')).text(), /Praise/);
  assert.match(await (await guest.request('/categories')).text(), /0 hymns/);
  const group = await (await guest.request('/composers?name=BOB%20JONES')).text();
  assert.match(group, /Credit One/);
  assert.match(group, /Credit Two/);
  assert.doesNotMatch(group, /Credit Three/);
  assert.equal((await guest.request('/composers?name=notfound')).status, 404);
  assert.equal((await guest.request('/composers?name=a&name=b')).status, 400);
  const hymn = (await get("SELECT id, slug, author_id FROM hymns WHERE title = 'Credit One'", []));
  const page = await (await guest.request(`/hymns/${hymn.slug}`)).text();
  assert.match(page, /href="\/composers\?name=Bob%20Jones">Bob Jones/);
  assert.match(page, new RegExp(`href="/authors/${hymn.author_id}">Distinct Lyricist`));
  assert.match(page, new RegExp(`href="/\\?category=${praise}">Praise`));
  const authorPage = await (await guest.request(`/authors/${hymn.author_id}`)).text();
  assert.match(authorPage, /Credit One/);
  assert.match(authorPage, /Credit Three/);
  assert.equal((await guest.request('/authors/999999')).status, 404);
  const adminPage = await (await admin.request('/admin')).text();
  assert.match(adminPage, /href="\/composers\?name=Bob%20Jones"/);
  assert.match(adminPage, new RegExp(`href="/\\?category=${praise}">Praise`));
  const api = await (await guest.request('/api/hymns')).json();
  assert.equal(api.find(item => item.id === hymn.id).composer, 'Alice & Co; Bob Jones');
});

test('composer and category directories search names case-insensitively', async () => {
  const guest = new Client();
  for (const [directory, query, expected, excluded] of [
    ['composers', '  bOB  ', 'Bob Jones', 'Alice &amp; Co'],
    ['categories', '  rAi  ', 'Praise', 'Worship']
  ]) {
    const response = await guest.request(`/${directory}?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<form method="get" action="/${directory}"`));
    assert.match(html, new RegExp(`value="${query.trim()}"`));
    assert.ok(html.includes(expected));
    assert.ok(!html.includes(`>${excluded}</a>`));
    assert.ok(html.includes(`href="/${directory}">Clear search`));
    const empty = await (await guest.request(`/${directory}?q=no-such-name`)).text();
    assert.match(empty, new RegExp(`No ${directory} found\\.`));
    assert.match(empty, /0 listed/);
    assert.equal((await guest.request(`/${directory}?q=a&q=b`)).status, 400);
    assert.equal((await guest.request(`/${directory}?q=${'x'.repeat(201)}`)).status, 400);
    const escaped = await (await guest.request(`/${directory}?q=${encodeURIComponent('<script>')}`)).text();
    assert.match(escaped, /value="&lt;script&gt;"/);
  }
  const matchingComposers = await (await guest.request('/composers?q=bob')).text();
  assert.match(matchingComposers, /Bob Jones<\/a>/);
  assert.match(matchingComposers, /Bob Jones Jr\.<\/a>/);
  assert.match(matchingComposers, /2 hymns/);
  const matchingCategories = await (await guest.request('/categories?q=pra')).text();
  assert.match(matchingCategories, /href="\/\?category=\d+">Praise<\/a>/);
});
