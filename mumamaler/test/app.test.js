const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const ejs = require('ejs');
const { Pool, types } = require('pg');
const { specs } = require('../../postgres-migration/export');

types.setTypeParser(20, value => Number(value));
const namespace = `muma_routes_test_${crypto.randomBytes(8).toString('hex')}`;
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
async function run(sql, values = []) {
  return db.query(sqlParameters(sql), values);
}
async function insertId(sql, values = []) {
  return (await db.query(`${sqlParameters(sql)} RETURNING id`, values)).rows[0].id;
}
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
  async token(url) {
    const html = await (await this.request(url)).text();
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match);
    return match[1];
  }
  async post(url, values, token) {
    return this.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...values, _csrf: token }) });
  }
  async login() { return this.post('/login', { email: 'ADMIN@example.com', password: 'password123' }, await this.token('/login')); }
}
test.before(async () => {
  if (!process.env.POSTGRES_TEST_URL) throw new Error('POSTGRES_TEST_URL is required');
  adminPool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await adminPool.query(`CREATE SCHEMA "${namespace}"`);
  schemaCreated = true;
  process.env.DATABASE_URL = process.env.POSTGRES_TEST_URL;
  process.env.PGOPTIONS = `-c search_path=${namespace},pg_catalog`;
  process.env.SESSION_SECRET = 'route-test-secret';
  db = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  await db.query(specs.mumamaler.schema);
  await db.query('INSERT INTO admins (email, password_hash) VALUES ($1, $2)', ['admin@example.com', bcrypt.hashSync('password123', 4)]);
  app = require('../app');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (app) {
    await app.locals.sessionStore.close();
    await app.locals.db.end();
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
  assert.match(home, /aria-hidden="true"><svg class="icon"><use href="\/icons.svg#book"/);
  for (const link of ['/privacy', '/terms', '/cookies']) assert.ok(home.includes(`href="${link}"`));
  const privacy = await (await guest.request('/privacy')).text();
  assert.match(privacy, /Contabo/);
  assert.match(privacy, /bookmarks, notes and tags/);
});

test('scripture search matches chapter bodies and links to matching chapters', async () => {
  const bookId = (await insertId("INSERT INTO books (name, book_order, testament, slug) VALUES ('Search book', 800, 'old', 'search-book')", []));
  const id = (await insertId('INSERT INTO chapters (book_id, number, title, body, slug) VALUES (?, ?, ?, ?, ?)', [bookId, 1, 'Search chapter', 'First line\nUnique 100% <secret> TEXT', 'search-chapter']));
  const guest = new Client();
  assert.match(await (await guest.request('/')).text(), /action="\/search"/);
  const result = await (await guest.request('/search?q=unique')).text();
  assert.match(result, /href="\/books\/search-book\/chapters\/search-chapter"/);
  assert.match(result, /&lt;secret&gt;/);
  assert.match(result, /1 matching chapter/);
  assert.match(await (await guest.request('/search?q=%25')).text(), /Search book/);
  assert.match(await (await guest.request('/search?q=not-present')).text(), /0 matching chapters/);
  assert.doesNotMatch(await (await guest.request('/search')).text(), /matching chapter/);
  assert.equal((await guest.request('/search?q=a&q=b')).status, 400);
  assert.equal((await guest.request(`/search?q=${'x'.repeat(201)}`)).status, 400);
  (await run('DELETE FROM chapters WHERE id = ?', [id]));
  (await run('DELETE FROM books WHERE id = ?', [bookId]));
});

test('books, shared metadata and chapter bodies can be managed and read', async () => {
  const guest = new Client();
  assert.match(await (await guest.request('/')).text(), /No books have been added yet/);
  assert.equal((await guest.request('/admin')).status, 302);
  const admin = new Client();
  assert.equal((await admin.login()).status, 302);
  let token = await admin.token('/admin/books/new');
  const first = { name: 'First book', book_order: '1', testament: 'old', author: 'Author', category: 'History' };
  assert.equal((await admin.post('/admin/books/new', { ...first, testament: '' }, token)).status, 400);
  assert.equal((await admin.post('/admin/books/new', first, 'invalid')).status, 403);
  assert.equal((await admin.post('/admin/books/new', first, token)).status, 302);
  assert.equal((await admin.post('/admin/books/new', { ...first, name: 'Second book', book_order: '2', testament: 'new', author: 'author', category: 'history' }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM authors', [])).n, 1);
  assert.equal((await get('SELECT count(*) n FROM categories', [])).n, 1);
  assert.equal((await admin.post('/admin/books/new', { ...first, name: 'Third book' }, token)).status, 409);
  const book = (await get('SELECT * FROM books WHERE name = ?', [first.name]));
  assert.equal(book.testament, 'old');
  assert.match(await (await guest.request('/')).text(), /Old Testament/);
  assert.match(await (await guest.request('/')).text(), /New Testament/);
  assert.match(await (await guest.request(`/books/${book.slug}`)).text(), /Author:\s*<a[^>]*>Author<\/a>/);
  const url = `/admin/books/${book.id}/chapters/new`;
  assert.equal((await guest.request(url)).status, 302);
  token = await admin.token(url);
  const body = '1 First line\n\n2 <script>second</script>';
  assert.equal((await admin.post(url, { number: '1', chapter_title: 'Beginning', body }, token)).status, 302);
  assert.equal((await admin.post(url, { number: '1', chapter_title: 'Duplicate', body: 'x' }, token)).status, 409);
  assert.equal((await admin.post(url, { number: '2', chapter_title: '', body: 'x' }, token)).status, 400);
  const chapter = (await get('SELECT * FROM chapters WHERE book_id = ? AND number = 1', [book.id]));
  assert.equal(chapter.body, body);
  const reader = await (await guest.request(`/books/${book.slug}/chapters/${chapter.slug}`)).text();
  assert.match(reader, /Beginning/);
  assert.match(reader, /1 First line\n\n2 &lt;script&gt;second&lt;\/script&gt;/);
  const edit = `/admin/books/${book.id}/chapters/${chapter.id}/edit`;
  assert.equal((await admin.post(edit, { number: '2', chapter_title: 'Changed', body: 'Updated body' }, token)).status, 302);
  assert.equal((await guest.request(`/books/${book.id}/chapters/1`)).status, 404);
  assert.match(await (await guest.request(`/books/${book.slug}/chapters/${chapter.slug}`)).text(), /Updated body/);
  assert.equal((await admin.post(`/admin/books/${book.id}/edit`, { ...first, testament: 'new' }, token)).status, 302);
  assert.equal((await get('SELECT testament FROM books WHERE id = ?', [book.id])).testament, 'new');
  assert.equal((await admin.post(`/admin/books/${book.id}/delete`, {}, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM chapters WHERE book_id = ?', [book.id])).n, 0);
});

test('metadata links lead to correctly filtered public book lists', async () => {
  const second = (await get("SELECT * FROM books WHERE name = 'Second book'", []));
  (await run('INSERT INTO books (name, book_order, testament, slug) VALUES (?, ?, ?, ?)', ['Unclassified', 3, 'old', 'unclassified']));
  (await run("INSERT INTO authors (name, slug) VALUES ('Unused', 'unused')", []));
  const unused = (await get("SELECT id, slug FROM authors WHERE name = 'Unused'", []));
  const authorSlug = (await get('SELECT slug FROM authors WHERE id = ?', [second.author_id])).slug;
  const categorySlug = (await get('SELECT slug FROM categories WHERE id = ?', [second.category_id])).slug;
  const guest = new Client();
  const home = await (await guest.request('/')).text();
  assert.match(home, new RegExp(`href="/authors/${authorSlug}"`));
  assert.match(home, new RegExp(`href="/categories/${categorySlug}"`));
  assert.match(home, /href="\/testaments\/new"/);
  const author = await (await guest.request(`/authors/${authorSlug}`)).text();
  assert.match(author, /Second book/);
  assert.doesNotMatch(author, /Unclassified/);
  const category = await (await guest.request(`/categories/${categorySlug}`)).text();
  assert.match(category, /Second book/);
  assert.doesNotMatch(category, /Unclassified/);
  const old = await (await guest.request('/testaments/old')).text();
  assert.match(old, /Unclassified/);
  assert.doesNotMatch(old, /Second book/);
  const modern = await (await guest.request('/testaments/new')).text();
  assert.match(modern, /Second book/);
  assert.doesNotMatch(modern, /Unclassified/);
  assert.match(await (await guest.request(`/authors/${unused.slug}`)).text(), /No books found/);
  for (const url of ['/authors/99999', '/categories/99999', '/authors/invalid', '/testaments/invalid']) {
    assert.equal((await guest.request(url)).status, 404);
  }
  const admin = new Client();
  await admin.login();
  const dashboard = await (await admin.request('/admin')).text();
  assert.match(dashboard, new RegExp(`href="/authors/${authorSlug}"`));
  assert.match(dashboard, new RegExp(`href="/categories/${categorySlug}"`));
  assert.match(dashboard, /href="\/testaments\/new"/);
  const details = await (await guest.request(`/books/${second.slug}`)).text();
  assert.match(details, new RegExp(`href="/authors/${authorSlug}"`));
  assert.match(details, new RegExp(`href="/categories/${categorySlug}"`));
  assert.match(details, /href="\/testaments\/new"/);
});

test('navigation and directory pages include all authors and categories', async () => {
  const guest = new Client();
  const paths = ['/', '/authors', '/categories', '/testaments/old', '/testaments/new'];
  for (const path of paths) {
    const response = await guest.request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const [href, label] of [['/', 'Books'], ['/authors', 'Authors'], ['/categories', 'Categories'], ['/testaments/old', 'Old Testament'], ['/testaments/new', 'New Testament']]) {
      assert.ok(html.includes(`<a href="${href}">${label}</a>`));
    }
  }
  const authors = await (await guest.request('/authors')).text();
  const unused = (await get("SELECT id, slug FROM authors WHERE name = 'Unused'", []));
  assert.match(authors, new RegExp(`href="/authors/${unused.slug}"`));
  assert.match(authors, /0 books/);
  const category = (await get("SELECT id, slug FROM categories WHERE name = 'History'", []));
  (await run('UPDATE categories SET description = ? WHERE id = ?', ['Historical category', category.id]));
  const categories = await (await guest.request('/categories')).text();
  assert.match(categories, new RegExp(`href="/categories/${category.slug}"`));
  assert.match(categories, /Historical category/);
  assert.match(categories, /1 book/);
});

test('search controls expose relevant data on public and admin lists', async () => {
  const guest = new Client();
  for (const [url, label] of [['/', 'Search books'], ['/authors', 'Search authors'], ['/categories', 'Search categories'], ['/testaments/new', 'Search books']]) {
    const response = await guest.request(url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, new RegExp(label));
    assert.match(html, /data-search-item data-search-text=/);
  }
  const book = (await get("SELECT id, slug FROM books WHERE name = 'Second book'", []));
  (await run("INSERT INTO chapters (book_id, number, title, body, slug) VALUES (?, 9, 'Chapter title', '', 'chapter-title')", [book.id]));
  const chapterHtml = await (await guest.request(`/books/${book.slug}`)).text();
  assert.match(chapterHtml, /Search chapters/);
  assert.match(chapterHtml, /data-search-text="9 Chapter title"/);
  const admin = new Client();
  await admin.login();
  assert.match(await (await admin.request('/admin')).text(), /Search books/);
  assert.match(await (await admin.request(`/admin/books/${book.id}/chapters`)).text(), /data-search-text="9 Chapter title"/);
});

test('only admins can view every live schema object', async () => {
  const guest = new Client();
  const denied = await guest.request('/admin/schema');
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), '/login');

  const admin = new Client();
  assert.equal((await admin.login()).status, 302);
  assert.match(await (await admin.request('/admin')).text(), /href="\/admin\/schema"/);
  const objects = (await db.query(`
    SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS sql
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
  `)).rows;
  const response = await admin.request('/admin/schema');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(objects.length);
  for (const object of objects) {
    assert.ok(html.includes(`<h2>${ejs.escapeXML(object.name)}</h2>`));
    if (object.sql) assert.ok(html.includes(`<code>${ejs.escapeXML(object.sql)}</code>`));
    else assert.match(html, /No definition is available\./);
  }
});

test('empty chapter placeholders can be read and edited', async () => {
  const book = (await get('SELECT id, slug FROM books WHERE name = ?', ['Second book']));
  (await run("INSERT INTO chapters (book_id, number, title, body, slug) VALUES (?, 1, '', '', 'chapter-1')", [book.id]));
  const chapter = (await get('SELECT id FROM chapters WHERE book_id = ? AND number = 1', [book.id]));
  const guest = new Client();
  const page = await guest.request(`/books/${book.slug}/chapters/chapter-1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /The chapter text has not been added yet/);
  const admin = new Client();
  await admin.login();
  const edit = `/admin/books/${book.id}/chapters/${chapter.id}/edit`;
  const token = await admin.token(edit);
  assert.equal((await admin.post(edit, { number: '1', chapter_title: 'Chapter one', body: 'Added text' }, token)).status, 302);
  assert.match(await (await guest.request(`/books/${book.slug}/chapters/chapter-one`)).text(), /Added text/);
});

test('reader accounts keep annotated bookmarks private and persistent', async () => {
  const bookId = (await insertId("INSERT INTO books (name, book_order, testament, slug) VALUES ('Saved test book', 100, 'old', 'saved-test-book')", []));
  const chapterId = (await insertId("INSERT INTO chapters (book_id, number, title, body, slug) VALUES (?, 1, 'Saved test chapter', 'Text', 'saved-test-chapter')", [bookId]));
  const page = '/books/saved-test-book/chapters/saved-test-chapter';
  const bookmark = `${page}/saved/bookmarks`;
  const edit = `${page}/bookmark/edit`;
  const guest = new Client();
  assert.equal((await guest.request('/bookmarks')).headers.get('location'), '/login');
  assert.equal((await guest.request('/profile')).headers.get('location'), '/login');
  assert.match(await (await guest.request(page)).text(), /Sign in<\/a> or/);
  assert.equal((await guest.post(bookmark, { action: 'add' }, await guest.token('/login'))).headers.get('location'), '/login');

  const first = new Client();
  let token = await first.token('/register');
  assert.equal((await first.post('/register', { email: 'bad', password: 'password123', confirmation: 'password123' }, token)).status, 400);
  assert.equal((await first.post('/register', { email: 'one@example.com', password: 'password123', confirmation: 'different' }, token)).status, 400);
  assert.equal((await first.post('/register', { email: 'admin@example.com', password: 'password123', confirmation: 'password123' }, token)).status, 409);
  assert.equal((await first.post('/register', { email: 'One@example.com', password: 'password123', confirmation: 'password123' }, 'invalid')).status, 403);
  assert.equal((await first.post('/register', { email: 'One@example.com', password: 'password123', confirmation: 'password123' }, token)).status, 302);
  assert.equal((await first.request('/admin')).headers.get('location'), '/login');
  const emptyProfile = await (await first.request('/profile')).text();
  assert.match(emptyProfile, /one@example.com/);
  assert.match(emptyProfile, /No bookmarks yet/);
  assert.doesNotMatch(emptyProfile, /Favourites/);
  token = await first.token(page);
  assert.equal((await first.post(bookmark, { action: 'add' }, token)).status, 302);
  assert.equal((await first.post(bookmark, { action: 'add' }, token)).status, 302);
  assert.equal((await first.post(`${page}/saved/favourites`, { action: 'add' }, token)).status, 404);
  assert.equal((await first.post(bookmark, { action: 'remove' }, 'invalid')).status, 403);
  assert.equal((await first.post(bookmark, { action: 'wrong' }, token)).status, 400);
  assert.equal((await first.post(`${page}/saved/invalid`, { action: 'add' }, token)).status, 404);
  assert.equal((await first.post('/books/saved-test-book/chapters/missing/saved/bookmarks', { action: 'add' }, token)).status, 404);
  assert.equal((await get('SELECT count(*) n FROM saved_chapters WHERE chapter_id = ?', [chapterId])).n, 1);
  assert.equal((await first.post(edit, { note: 'x'.repeat(5001), tags: 'tag' }, token)).status, 400);
  assert.equal((await first.post(edit, { note: 'note', tags: 'x'.repeat(501) }, token)).status, 400);
  assert.equal((await first.post(edit, { note: 'Line one\n<script>two</script>', tags: 'hope, faith' }, token)).status, 302);
  assert.match(await (await first.request(page)).text(), /Remove Bookmark/);
  assert.match(await (await first.request('/bookmarks')).text(), /Saved test book 1: Saved test chapter/);
  const savedPage = await (await first.request('/bookmarks')).text();
  assert.match(savedPage, /Line one\n&lt;script&gt;two&lt;\/script&gt;/);
  assert.match(savedPage, /hope, faith/);
  assert.match(savedPage, /data-search-text="[^"]*hope, faith/);
  assert.match(await (await first.request(edit)).text(), /hope, faith/);
  const profile = await (await first.request('/profile')).text();
  assert.match(profile, /href="\/profile">Profile/);
  assert.equal((profile.match(/Saved test book 1: Saved test chapter/g) || []).length, 1);
  assert.match(profile, /id="search-bookmarks"/);
  assert.match(profile, /hope, faith/);
  assert.doesNotMatch(profile, /Favourites/);
  assert.match(profile, /href="\/books\/saved-test-book\/chapters\/saved-test-chapter"/);

  const second = new Client();
  token = await second.token('/register');
  assert.equal((await second.post('/register', { email: 'ONE@example.com', password: 'password123', confirmation: 'password123' }, token)).status, 409);
  assert.equal((await second.post('/register', { email: 'two@example.com', password: 'password123', confirmation: 'password123' }, token)).status, 302);
  assert.doesNotMatch(await (await second.request('/bookmarks')).text(), /Saved test chapter/);
  assert.equal((await second.request(edit)).status, 404);
  token = await second.token('/profile');
  assert.equal((await second.post(edit, { note: 'stolen', tags: 'bad' }, token)).status, 404);
  assert.doesNotMatch(await (await second.request('/profile')).text(), /Saved test chapter/);
  token = await second.token(page);
  await second.post(bookmark, { action: 'remove' }, token);
  assert.match(await (await first.request('/bookmarks')).text(), /Saved test chapter/);

  const admin = new Client();
  await admin.login();
  token = await admin.token(page);
  await admin.post(bookmark, { action: 'add' }, token);
  assert.match(await (await admin.request('/bookmarks')).text(), /Saved test chapter/);
  const adminProfile = await (await admin.request('/profile')).text();
  assert.match(adminProfile, /admin@example.com/);
  assert.match(adminProfile, /Saved test chapter/);
  assert.doesNotMatch(adminProfile, /hope, faith/);
  assert.match(await (await admin.request(page)).text(), /href="\/admin">Admin/);

  token = await first.token('/bookmarks');
  await first.post('/logout', {}, token);
  token = await first.token('/login');
  assert.equal((await first.post('/login', { email: 'ONE@example.com', password: 'wrong' }, token)).status, 401);
  assert.equal((await first.post('/login', { email: 'ONE@example.com', password: 'password123' }, token)).status, 302);
  assert.match(await (await first.request('/bookmarks')).text(), /Saved test chapter/);
  assert.match(await (await first.request('/bookmarks')).text(), /hope, faith/);
  (await run('UPDATE chapters SET number = 2 WHERE id = ?', [chapterId]));
  assert.match(await (await first.request('/bookmarks')).text(), /\/books\/saved-test-book\/chapters\/saved-test-chapter/);
  const newBookmark = '/books/saved-test-book/chapters/saved-test-chapter/saved/bookmarks';
  token = await first.token('/profile');
  const removed = await first.post(newBookmark, { action: 'remove', from: 'profile' }, token);
  assert.equal(removed.headers.get('location'), '/profile');
  assert.doesNotMatch(await (await first.request('/bookmarks')).text(), /Saved test chapter/);
  assert.match(await (await first.request('/profile')).text(), /No bookmarks yet/);
  assert.match(await (await admin.request('/bookmarks')).text(), /Saved test chapter/);

  (await run('DELETE FROM chapters WHERE id = ?', [chapterId]));
  assert.equal((await get('SELECT count(*) n FROM saved_chapters WHERE chapter_id = ?', [chapterId])).n, 0);
  assert.doesNotMatch(await (await admin.request('/bookmarks')).text(), /Saved test chapter/);
});

test('readers and admins can delete reader accounts and invalidate all reader sessions', async () => {
  const bookId = (await insertId("INSERT INTO books (name, book_order, testament, slug) VALUES ('Deletion test', 101, 'old', 'deletion-test')", []));
  const chapterId = (await insertId("INSERT INTO chapters (book_id, number, title, body, slug) VALUES (?, 1, 'Test', 'Text', 'test')", [bookId]));
  const register = async (client, email) => {
    const token = await client.token('/register');
    assert.equal((await client.post('/register', { email, password: 'password123', confirmation: 'password123' }, token)).status, 302);
    return (await get('SELECT id FROM readers WHERE email = ?', [email])).id;
  };
  const reader = new Client();
  const readerId = await register(reader, 'deletion@example.com');
  const guest = new Client();
  assert.doesNotMatch(await (await guest.request('/')).text(), /href="\/admin\/readers">Users/);
  assert.equal((await guest.request('/admin/readers')).headers.get('location'), '/login');
  const otherSession = new Client();
  let token = await otherSession.token('/login');
  await otherSession.post('/login', { email: 'deletion@example.com', password: 'password123' }, token);
  token = await reader.token('/profile');
  assert.match(await (await reader.request('/profile')).text(), /href="\/profile\/delete"/);
  assert.doesNotMatch(await (await reader.request('/profile')).text(), /href="\/admin\/readers">Users/);
  assert.equal((await reader.request('/admin/readers')).headers.get('location'), '/login');
  assert.equal((await reader.post(`/admin/readers/${readerId}/delete`, { confirm: 'delete' }, token)).headers.get('location'), '/login');
  await reader.post('/books/deletion-test/chapters/test/saved/bookmarks', { action: 'add' }, token);
  await reader.post('/books/deletion-test/chapters/test/bookmark/edit', { note: 'Private note', tags: 'private' }, token);
  assert.equal((await reader.post('/profile/delete', { password: 'password123', confirm: 'delete' }, 'invalid')).status, 403);
  assert.equal((await reader.post('/profile/delete', { password: 'wrong', confirm: 'delete' }, token)).status, 400);
  assert.equal((await reader.post('/profile/delete', { password: 'password123' }, token)).status, 400);
  assert.ok((await get('SELECT id FROM readers WHERE id = ?', [readerId])));
  assert.equal((await reader.post('/profile/delete', { password: 'password123', confirm: 'delete' }, token)).status, 200);
  assert.equal((await get('SELECT id FROM readers WHERE id = ?', [readerId])), undefined);
  assert.equal((await get('SELECT count(*) n FROM saved_chapters WHERE reader_id = ?', [readerId])).n, 0);
  assert.ok((await get('SELECT id FROM chapters WHERE id = ?', [chapterId])));
  assert.equal((await reader.request('/profile')).headers.get('location'), '/login');

  const replacement = new Client();
  await db.query("SELECT setval(pg_get_serial_sequence('readers', 'id'), $1, false)", [readerId]);
  assert.equal(await register(replacement, 'deletion@example.com'), readerId);
  assert.equal((await otherSession.request('/profile')).headers.get('location'), '/login');
  const login = new Client();
  token = await login.token('/login');
  assert.equal((await login.post('/login', { email: 'deletion@example.com', password: 'password123' }, token)).status, 302);

  const admin = new Client();
  await admin.login();
  const adminPage = await (await admin.request('/admin')).text();
  assert.match(adminPage, /href="\/admin\/readers"/);
  assert.match(adminPage, /href="\/admin\/readers">Users/);
  assert.doesNotMatch(await (await admin.request('/profile')).text(), /Delete my account/);
  assert.equal((await admin.request('/profile/delete')).status, 403);
  token = await admin.token('/admin/readers');
  const usersPage = await (await admin.request('/admin/readers')).text();
  assert.match(usersPage, /<h1>Users<\/h1>/);
  assert.match(usersPage, /deletion@example.com/);
  assert.match(usersPage, /admin@example.com/);
  assert.match(usersPage, /Search users/);
  assert.match(usersPage, new RegExp(`href="/admin/readers/${readerId}/delete"`));
  assert.doesNotMatch(usersPage, /aria-label="Delete admin@example.com"/);
  const confirmPage = await (await admin.request(`/admin/readers/${readerId}/delete`)).text();
  const accountToken = confirmPage.match(/name="accountToken" value="([^"]+)"/)[1];
  assert.equal((await admin.post(`/admin/readers/${readerId}/delete`, { accountToken, confirm: 'delete' }, 'invalid')).status, 403);
  assert.equal((await admin.post(`/admin/readers/${readerId}/delete`, { accountToken }, token)).status, 400);
  assert.equal((await admin.post(`/admin/readers/${readerId}/delete`, { accountToken: 'invalid', confirm: 'delete' }, token)).status, 409);
  const replacementToken = await replacement.token('/books/deletion-test/chapters/test');
  await replacement.post('/books/deletion-test/chapters/test/saved/bookmarks', { action: 'add' }, replacementToken);
  assert.equal((await admin.post(`/admin/readers/${readerId}/delete`, { accountToken, confirm: 'delete' }, token)).status, 302);
  assert.equal((await get('SELECT count(*) n FROM saved_chapters WHERE reader_id = ?', [readerId])).n, 0);
  assert.equal((await replacement.request('/profile')).headers.get('location'), '/login');
  assert.equal((await login.request('/profile')).headers.get('location'), '/login');
  assert.equal((await admin.request(`/admin/readers/${readerId}/delete`)).status, 404);
  assert.equal((await admin.request('/admin/readers/invalid/delete')).status, 404);
  assert.ok((await get("SELECT id FROM admins WHERE email = 'admin@example.com'", [])));
});

test('slugs are unique, public, stable on edits and used in chapter navigation', async () => {
  const admin = new Client();
  await admin.login();
  const token = await admin.token('/admin/books/new');
  const book = { name: 'Á B', book_order: '102', testament: 'old', author: 'A B', category: 'A B' };
  assert.equal((await admin.post('/admin/books/new', book, token)).status, 302);
  assert.equal((await admin.post('/admin/books/new', { ...book, name: 'A-B', book_order: '103', author: 'A-B', category: 'A-B' }, token)).status, 302);
  const first = (await get("SELECT * FROM books WHERE name = 'Á B'", []));
  const second = (await get("SELECT * FROM books WHERE name = 'A-B'", []));
  assert.equal(first.slug, 'a-b');
  assert.equal(second.slug, 'a-b-2');
  assert.equal((await get('SELECT slug FROM authors WHERE id = ?', [second.author_id])).slug, 'a-b-2');
  assert.equal((await get('SELECT slug FROM categories WHERE id = ?', [second.category_id])).slug, 'a-b-2');
  const add = `/admin/books/${first.id}/chapters/new`;
  assert.equal((await admin.post(add, { number: '1', chapter_title: 'Dhoʼ Luo', body: 'First' }, token)).status, 302);
  assert.equal((await admin.post(add, { number: '2', chapter_title: 'Dho Luo', body: 'Second' }, token)).status, 302);
  assert.equal((await admin.post(add, { number: '3', chapter_title: '!!!', body: 'Third' }, token)).status, 302);
  const chapters = (await all('SELECT * FROM chapters WHERE book_id = ? ORDER BY number', [first.id]));
  assert.deepEqual(chapters.map(c => c.slug), ['dho-luo', 'dho-luo-2', 'chapter-3']);
  const guest = new Client();
  const page = await (await guest.request('/books/a-b/chapters/dho-luo')).text();
  assert.match(page, /href="\/books\/a-b\/chapters\/dho-luo-2">Chapter 2/);
  assert.equal((await guest.request(`/books/${first.id}`)).status, 404);
  assert.equal((await guest.request('/books/a-b/chapters/1')).status, 404);
  assert.equal((await guest.request(`/authors/${first.author_id}`)).status, 404);
  assert.equal((await guest.request(`/categories/${first.category_id}`)).status, 404);
  assert.equal((await admin.post(`/admin/books/${first.id}/edit`, { ...book, name: 'Renamed' }, token)).status, 302);
  assert.equal((await admin.post(`/admin/books/${first.id}/chapters/${chapters[0].id}/edit`, { number: '1', chapter_title: 'Renamed chapter', body: 'Changed' }, token)).status, 302);
  assert.match(await (await guest.request('/books/a-b/chapters/dho-luo')).text(), /Renamed chapter/);
  assert.equal((await guest.request('/books/renamed')).status, 404);
  await assert.rejects(run("INSERT INTO authors (name) VALUES ('No slug')", []), { code: '23502' });
});
