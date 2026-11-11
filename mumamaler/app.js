const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./postgres');
const { normalizeEmail, isValidEmail } = require('./account');
const { slugBase } = require('./slugs');

const app = express();
if (process.env.TRUST_PROXY === 'loopback') app.set('trust proxy', 'loopback');
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
const sessionStore = new (require('connect-pg-simple')(session))({ pool: db, createTableIfMissing: true });
app.use(session({
  name: 'mumamaler.sid',
  secret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(async (req, res, next) => {
  if (req.session.reader) {
    const active = (await db.query('SELECT 1 FROM readers WHERE id = $1 AND session_key = $2', [
      req.session.reader.id, req.session.reader.sessionKey || ''
    ])).rows[0];
    if (!active) {
      return req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie('mumamaler.sid');
        res.redirect('/login');
      });
    }
  }
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.admin = req.session.admin || null;
  res.locals.reader = req.session.reader || req.session.admin || null;
  res.set('Cache-Control', 'no-store');
  if (req.method === 'POST' && (typeof req.body?._csrf !== 'string' || req.body._csrf !== req.session.csrf)) {
    return res.status(403).send('Invalid or expired form. Reload the page and try again.');
  }
  next();
});

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/login');
  next();
}

function requireReader(req, res, next) {
  if (!req.session.reader && !req.session.admin) return res.redirect('/login');
  next();
}

function savedOwner(req) {
  return req.session.admin
    ? { column: 'admin_id', id: req.session.admin.id }
    : { column: 'reader_id', id: req.session.reader.id };
}

const bookQuery = `
  SELECT b.*, a.name AS author, a.slug AS author_slug, cat.name AS category, cat.slug AS category_slug, COUNT(c.id)::integer AS chapter_count
  FROM books b LEFT JOIN authors a ON a.id = b.author_id
  LEFT JOIN categories cat ON cat.id = b.category_id
  LEFT JOIN chapters c ON c.book_id = b.id
`;
const bookGroup = ' GROUP BY b.id, a.name, a.slug, cat.name, cat.slug ORDER BY b.book_order';
const listBooks = async () => (await db.query(bookQuery + bookGroup)).rows;
for (const [url, title, page] of [
  ['/privacy', 'Privacy policy', 'privacy'],
  ['/terms', 'Terms of use', 'terms'],
  ['/cookies', 'Cookie and storage notice', 'cookies']
]) {
  app.get(url, (req, res) => res.render('legal', { title, page }));
}
const booksByAuthor = async id => (await db.query(`${bookQuery} WHERE b.author_id = $1 ${bookGroup}`, [id])).rows;
const booksByCategory = async id => (await db.query(`${bookQuery} WHERE b.category_id = $1 ${bookGroup}`, [id])).rows;
const booksByTestament = async testament => (await db.query(`${bookQuery} WHERE b.testament = $1 ${bookGroup}`, [testament])).rows;
const bookDetails = 'SELECT b.*, a.name AS author, a.slug AS author_slug, c.name AS category, c.slug AS category_slug FROM books b LEFT JOIN authors a ON a.id = b.author_id LEFT JOIN categories c ON c.id = b.category_id';
const getBook = async id => (await db.query(`${bookDetails} WHERE b.id = $1`, [id])).rows[0];
const getBookBySlug = async slug => (await db.query(`${bookDetails} WHERE b.slug = $1`, [slug])).rows[0];
const bookFormLists = async () => ({
  authors: (await db.query('SELECT name FROM authors ORDER BY lower(name COLLATE "C")')).rows,
  categories: (await db.query('SELECT name FROM categories ORDER BY lower(name COLLATE "C")')).rows
});

function positiveInt(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : null;
}

async function withSlugTransaction(action) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(15377002)');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Slug transaction rollback failed:', rollbackError); }
    throw error;
  } finally {
    client.release();
  }
}

async function uniqueSlug(client, table, value, fallback, bookId = null, excludeId = null) {
  if (!['authors', 'categories', 'books', 'chapters'].includes(table)) throw new Error('Invalid slug table');
  const base = slugBase(value, fallback);
  let slug = base;
  let suffix = 2;
  while (true) {
    const result = table === 'chapters'
      ? await client.query('SELECT 1 FROM chapters WHERE book_id = $1 AND slug = $2 AND id <> $3', [bookId, slug, excludeId || 0])
      : await client.query(`SELECT 1 FROM ${table} WHERE slug = $1 AND id <> $2`, [slug, excludeId || 0]);
    if (!result.rowCount) return slug;
    slug = `${base}-${suffix++}`;
  }
}

app.get('/', async (req, res) => res.render('home', { title: 'Bible', books: await listBooks() }));

app.get('/search', async (req, res) => {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).send('Invalid search query.');
  const query = (req.query.q || '').trim();
  if (query.length > 200) return res.status(400).send('Search query must be at most 200 characters.');
  const needle = query.toLocaleLowerCase();
  const results = [];
  if (needle) {
    const chapters = (await db.query(`
      SELECT b.name AS book_name, b.slug AS book_slug, c.number, c.title, c.slug AS chapter_slug, c.body
      FROM chapters c JOIN books b ON b.id = c.book_id ORDER BY b.book_order, c.number
    `)).rows;
    for (const chapter of chapters) {
      const position = chapter.body.toLocaleLowerCase().indexOf(needle);
      if (position === -1) continue;
      const start = Math.max(0, position - 80);
      const end = Math.min(chapter.body.length, position + query.length + 100);
      results.push({ ...chapter, body: undefined, excerpt: `${start ? '…' : ''}${chapter.body.slice(start, end)}${end < chapter.body.length ? '…' : ''}` });
    }
  }
  res.render('search-results', { title: 'Search scripture', query, results });
});

app.get('/authors', async (req, res) => {
  const items = (await db.query(`
    SELECT a.id, a.name, a.slug, COUNT(b.id)::integer AS book_count
    FROM authors a LEFT JOIN books b ON b.author_id = a.id
    GROUP BY a.id ORDER BY lower(a.name COLLATE "C"), a.id
  `)).rows;
  res.render('directory', { title: 'Authors', items, path: '/authors' });
});

app.get('/categories', async (req, res) => {
  const items = (await db.query(`
    SELECT c.id, c.name, c.slug, c.description, COUNT(b.id)::integer AS book_count
    FROM categories c LEFT JOIN books b ON b.category_id = c.id
    GROUP BY c.id ORDER BY lower(c.name COLLATE "C"), c.id
  `)).rows;
  res.render('directory', { title: 'Categories', items, path: '/categories' });
});

app.get('/authors/:id', async (req, res) => {
  const author = (await db.query('SELECT id, name FROM authors WHERE slug = $1', [req.params.id])).rows[0];
  if (!author) return res.status(404).render('message', { title: 'Not found', message: 'Author not found.' });
  res.render('book-group', { title: author.name, heading: 'Author', description: null, books: await booksByAuthor(author.id) });
});

app.get('/categories/:id', async (req, res) => {
  const category = (await db.query('SELECT id, name, description FROM categories WHERE slug = $1', [req.params.id])).rows[0];
  if (!category) return res.status(404).render('message', { title: 'Not found', message: 'Category not found.' });
  res.render('book-group', { title: category.name, heading: 'Category', description: category.description, books: await booksByCategory(category.id) });
});

app.get('/testaments/:testament', async (req, res) => {
  const { testament } = req.params;
  if (!['old', 'new'].includes(testament)) return res.status(404).render('message', { title: 'Not found', message: 'Testament not found.' });
  res.render('book-group', { title: testament === 'old' ? 'Old Testament' : 'New Testament', heading: 'Testament', description: null, books: await booksByTestament(testament) });
});

app.get('/books/:id', async (req, res) => {
  const book = await getBookBySlug(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  const chapters = (await db.query('SELECT number, title, slug FROM chapters WHERE book_id = $1 ORDER BY number', [book.id])).rows;
  res.render('book', { title: book.name, book, chapters });
});

app.get('/books/:id/chapters/:chapter', async (req, res) => {
  const book = await getBookBySlug(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  const chapter = (await db.query('SELECT * FROM chapters WHERE book_id = $1 AND slug = $2', [book.id, req.params.chapter])).rows[0];
  if (!chapter) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  const chapters = (await db.query('SELECT number, slug FROM chapters WHERE book_id = $1 ORDER BY number', [book.id])).rows;
  const position = chapters.findIndex(row => row.number === chapter.number);
  const owner = res.locals.reader && savedOwner(req);
  const bookmark = owner
    ? (await db.query(`SELECT id FROM saved_chapters WHERE ${owner.column} = $1 AND chapter_id = $2 AND kind = 'bookmark'`, [owner.id, chapter.id])).rows[0]
    : null;
  res.render('chapter', {
    title: `${book.name} ${chapter.number}`, book, chapter, bookmark,
    previous: chapters[position - 1] || null,
    next: chapters[position + 1] || null
  });
});

app.get('/login', (req, res) => res.render('login', { title: 'Sign in', error: null, email: '' }));
app.post('/login', async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const admin = (await db.query('SELECT id, email, password_hash FROM admins WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")', [email])).rows[0];
  const reader = (await db.query('SELECT id, email, password_hash, session_key FROM readers WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")', [email])).rows[0];
  const validPassword = Buffer.byteLength(password) <= 72;
  const authenticatedAdmin = validPassword && admin && bcrypt.compareSync(password, admin.password_hash);
  const authenticatedReader = validPassword && reader && bcrypt.compareSync(password, reader.password_hash);
  if (!authenticatedAdmin && !authenticatedReader) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid email or password.', email });
  }
  req.session.regenerate(error => {
    if (error) return next(error);
    if (authenticatedAdmin) req.session.admin = { id: admin.id, email: admin.email };
    else req.session.reader = { id: reader.id, email: reader.email, sessionKey: reader.session_key };
    req.session.save(error => {
      if (error) return next(error);
      res.redirect(authenticatedAdmin ? '/admin' : '/');
    });
  });
});
app.get('/register', (req, res) => res.render('register', { title: 'Create account', error: null, email: '' }));
app.post('/register', async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation : '';
  const options = { title: 'Create account', error: null, email };
  if (!isValidEmail(email) || password.length < 8 || Buffer.byteLength(password) > 72) {
    options.error = 'Enter a valid email and a password of at least 8 characters and at most 72 bytes.';
    return res.status(400).render('register', options);
  }
  if (password !== confirmation) {
    options.error = 'Passwords do not match.';
    return res.status(400).render('register', options);
  }
  const sessionKey = crypto.randomBytes(32).toString('hex');
  const client = await db.connect();
  let reader;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(15377001, hashtext(lower($1)))', [email]);
    const existing = await client.query(`
      SELECT 1 FROM admins WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")
      UNION ALL SELECT 1 FROM readers WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")
    `, [email]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      options.error = 'An account with that email already exists. Please sign in.';
      return res.status(409).render('register', options);
    }
    reader = (await client.query('INSERT INTO readers (email, password_hash, session_key) VALUES ($1, $2, $3) RETURNING id', [email, bcrypt.hashSync(password, 10), sessionKey])).rows[0];
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Registration rollback failed:', rollbackError); }
    if (error.code === '23505') {
      options.error = 'An account with that email already exists. Please sign in.';
      return res.status(409).render('register', options);
    }
    throw error;
  } finally {
    client.release();
  }
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.reader = { id: reader.id, email, sessionKey };
    req.session.save(error => {
      if (error) return next(error);
      res.redirect('/');
    });
  });
});
app.post('/logout', requireReader, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('mumamaler.sid');
    res.redirect('/');
  });
});

async function listBookmarks(req) {
  const owner = savedOwner(req);
  return (await db.query(`
    SELECT c.id, c.number, c.title, c.slug AS chapter_slug, b.slug AS book_slug, b.name AS book_name, s.note, s.tags
    FROM saved_chapters s JOIN chapters c ON c.id = s.chapter_id
    JOIN books b ON b.id = c.book_id
    WHERE s.${owner.column} = $1 AND s.kind = 'bookmark'
    ORDER BY b.book_order, c.number
  `, [owner.id])).rows;
}
app.get('/profile', requireReader, async (req, res) => {
  res.render('profile', {
    title: 'Profile',
    bookmarks: await listBookmarks(req)
  });
});
app.get('/profile/delete', requireReader, (req, res) => {
  if (!req.session.reader) return res.status(403).render('message', { title: 'Forbidden', message: 'Administrator accounts cannot be deleted here.' });
  res.render('delete-reader', { title: 'Delete account', account: req.session.reader, self: true, error: null });
});
app.post('/profile/delete', requireReader, async (req, res, next) => {
  if (!req.session.reader) return res.status(403).render('message', { title: 'Forbidden', message: 'Administrator accounts cannot be deleted here.' });
  const account = (await db.query('SELECT id, email, password_hash FROM readers WHERE id = $1 AND session_key = $2', [req.session.reader.id, req.session.reader.sessionKey])).rows[0];
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!account || Buffer.byteLength(password) > 72 || !bcrypt.compareSync(password, account.password_hash)) {
    return res.status(400).render('delete-reader', { title: 'Delete account', account: req.session.reader, self: true, error: 'Incorrect password. Your account was not deleted.' });
  }
  if (req.body.confirm !== 'delete') {
    return res.status(400).render('delete-reader', { title: 'Delete account', account: req.session.reader, self: true, error: 'Confirm that you want to permanently delete your account.' });
  }
  await db.query('DELETE FROM readers WHERE id = $1 AND session_key = $2', [account.id, req.session.reader.sessionKey]);
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('mumamaler.sid');
    res.locals.reader = null;
    res.locals.admin = null;
    res.render('message', { title: 'Account deleted', message: 'Your reader account and bookmarks have been deleted.' });
  });
});
app.get('/bookmarks', requireReader, async (req, res) => {
  res.render('saved-chapters', { title: 'Bookmarks', chapters: await listBookmarks(req) });
});

app.post('/books/:id/chapters/:chapter/saved/:collection', requireReader, async (req, res) => {
  if (req.params.collection !== 'bookmarks') {
    return res.status(404).render('message', { title: 'Not found', message: 'Page not found.' });
  }
  const chapter = (await db.query('SELECT c.id, c.slug, b.slug AS book_slug FROM chapters c JOIN books b ON b.id = c.book_id WHERE b.slug = $1 AND c.slug = $2', [req.params.id, req.params.chapter])).rows[0];
  if (!chapter) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  if (!['add', 'remove'].includes(req.body?.action)) {
    return res.status(400).render('message', { title: 'Invalid action', message: 'Choose whether to add or remove the chapter.' });
  }
  const owner = savedOwner(req);
  if (req.body.action === 'add') {
    await db.query(`INSERT INTO saved_chapters (chapter_id, ${owner.column}, kind) VALUES ($1, $2, 'bookmark') ON CONFLICT DO NOTHING`, [chapter.id, owner.id]);
  } else {
    await db.query(`DELETE FROM saved_chapters WHERE chapter_id = $1 AND ${owner.column} = $2 AND kind = 'bookmark'`, [chapter.id, owner.id]);
  }
  const destination = req.body.from === 'profile' ? '/profile'
    : req.body.from === 'collection' ? '/bookmarks' : `/books/${encodeURIComponent(chapter.book_slug)}/chapters/${encodeURIComponent(chapter.slug)}`;
  res.redirect(destination);
});

async function getBookmark(req) {
  const owner = savedOwner(req);
  return (await db.query(`
    SELECT s.id, s.note, s.tags, c.number, c.slug AS chapter_slug, b.slug AS book_slug, b.name AS book_name
    FROM saved_chapters s JOIN chapters c ON c.id = s.chapter_id
    JOIN books b ON b.id = c.book_id
    WHERE s.${owner.column} = $1 AND s.kind = 'bookmark' AND b.slug = $2 AND c.slug = $3
  `, [owner.id, req.params.id, req.params.chapter])).rows[0];
}
app.get('/books/:id/chapters/:chapter/bookmark/edit', requireReader, async (req, res) => {
  const bookmark = await getBookmark(req);
  if (!bookmark) return res.status(404).render('message', { title: 'Not found', message: 'Bookmark not found.' });
  res.render('bookmark-form', { title: 'Edit bookmark', bookmark, error: null });
});
app.post('/books/:id/chapters/:chapter/bookmark/edit', requireReader, async (req, res) => {
  const bookmark = await getBookmark(req);
  if (!bookmark) return res.status(404).render('message', { title: 'Not found', message: 'Bookmark not found.' });
  const note = typeof req.body.note === 'string' ? req.body.note : '';
  const tags = typeof req.body.tags === 'string' ? req.body.tags : '';
  if (typeof req.body.note !== 'string' || typeof req.body.tags !== 'string' || note.length > 5000 || tags.length > 500) {
    return res.status(400).render('bookmark-form', { title: 'Edit bookmark', bookmark: { ...bookmark, note, tags }, error: 'Notes must be at most 5,000 characters and tags at most 500 characters.' });
  }
  await db.query('UPDATE saved_chapters SET note = $1, tags = $2 WHERE id = $3', [note, tags, bookmark.id]);
  res.redirect('/bookmarks');
});

app.get('/admin', requireAdmin, async (req, res) => {
  res.render('admin', { title: 'Manage Bible', books: await listBooks() });
});

app.get('/admin/readers', requireAdmin, async (req, res) => {
  const users = (await db.query(`
    SELECT id, email, 'reader' AS role FROM readers
    UNION ALL
    SELECT id, email, 'admin' AS role FROM admins
    ORDER BY email, role, id
  `)).rows.sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()) || a.role.localeCompare(b.role) || a.id - b.id);
  res.render('admin-readers', { title: 'Users', users });
});
app.get('/admin/readers/:id/delete', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  const account = id && (await db.query('SELECT id, email, session_key FROM readers WHERE id = $1', [id])).rows[0];
  if (!account) return res.status(404).render('message', { title: 'Not found', message: 'Reader not found.' });
  const accountToken = crypto.createHash('sha256').update(account.session_key).digest('hex');
  res.render('delete-reader', { title: 'Delete reader', account, accountToken, self: false, error: null });
});
app.post('/admin/readers/:id/delete', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  const account = id && (await db.query('SELECT id, email, session_key FROM readers WHERE id = $1', [id])).rows[0];
  if (!account) return res.status(404).render('message', { title: 'Not found', message: 'Reader not found.' });
  const accountToken = crypto.createHash('sha256').update(account.session_key).digest('hex');
  if (req.body.accountToken !== accountToken) {
    return res.status(409).render('message', { title: 'Account changed', message: 'This account has changed. Return to the reader list and try again.' });
  }
  if (req.body.confirm !== 'delete') {
    return res.status(400).render('delete-reader', { title: 'Delete reader', account, accountToken, self: false, error: 'Confirm that you want to permanently delete this reader.' });
  }
  const deleted = await db.query('DELETE FROM readers WHERE id = $1 AND session_key = $2', [id, account.session_key]);
  if (!deleted.rowCount) return res.status(409).render('message', { title: 'Account changed', message: 'This account has changed. Return to the reader list and try again.' });
  res.redirect('/admin/readers');
});

app.get('/admin/schema', requireAdmin, async (req, res) => {
  const { rows: objects } = await db.query(`
    SELECT 'table' AS type, c.relname AS name, c.relname AS tbl_name,
      string_agg(format('%I %s%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
        CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END), E'\\n' ORDER BY a.attnum) AS sql
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
    GROUP BY c.oid, c.relname
    UNION ALL SELECT 'index', i.relname, c.relname, pg_catalog.pg_get_indexdef(i.oid)
    FROM pg_catalog.pg_class i JOIN pg_catalog.pg_index x ON x.indexrelid=i.oid
    JOIN pg_catalog.pg_class c ON c.oid=x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema()
    UNION ALL SELECT 'constraint', con.conname, c.relname, pg_catalog.pg_get_constraintdef(con.oid)
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
    UNION ALL SELECT 'trigger', t.tgname, c.relname, pg_catalog.pg_get_triggerdef(t.oid)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal
    ORDER BY type, name
  `);
  res.render('admin-schema', { title: 'Database Schema', objects });
});

app.get('/admin/books/new', requireAdmin, async (req, res) => {
  res.render('book-form', { title: 'Add book', book: { name: '', book_order: '', testament: '', author: '', category: '' }, ...await bookFormLists(), action: '/admin/books/new', error: null });
});
app.get('/admin/books/:id/edit', requireAdmin, async (req, res) => {
  const book = positiveInt(req.params.id) && await getBook(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  res.render('book-form', { title: 'Edit book', book, ...await bookFormLists(), action: `/admin/books/${book.id}/edit`, error: null });
});
async function saveBook(req, res, next) {
  const editing = Boolean(req.params.id);
  const existing = editing && positiveInt(req.params.id) ? await getBook(req.params.id) : null;
  if (editing && !existing) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const order = positiveInt(req.body.book_order);
  const author = typeof req.body.author === 'string' ? req.body.author.trim() : '';
  const category = typeof req.body.category === 'string' ? req.body.category.trim() : '';
  const testament = req.body.testament;
  const options = { title: editing ? 'Edit book' : 'Add book', book: req.body, ...await bookFormLists(), action: req.path, error: null };
  if (!name || name.length > 200 || !order || !['old', 'new'].includes(testament) || author.length > 200 || category.length > 200) {
    options.error = 'Enter a book name, a positive index, and a testament. Names, authors and categories must be at most 200 characters.';
    return res.status(400).render('book-form', options);
  }
  try {
    await withSlugTransaction(async client => {
      let authorId = null;
      let categoryId = null;
      if (author) {
        const found = (await client.query('SELECT id FROM authors WHERE lower(name COLLATE "C") = lower($1 COLLATE "C")', [author])).rows[0];
        authorId = found ? found.id : (await client.query('INSERT INTO authors (name, slug) VALUES ($1, $2) RETURNING id', [author, await uniqueSlug(client, 'authors', author, 'author')])).rows[0].id;
      }
      if (category) {
        const found = (await client.query('SELECT id FROM categories WHERE lower(name COLLATE "C") = lower($1 COLLATE "C")', [category])).rows[0];
        categoryId = found ? found.id : (await client.query('INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id', [category, await uniqueSlug(client, 'categories', category, 'category')])).rows[0].id;
      }
      if (editing) await client.query('UPDATE books SET name = $1, book_order = $2, testament = $3, author_id = $4, category_id = $5 WHERE id = $6', [name, order, testament, authorId, categoryId, existing.id]);
      else await client.query('INSERT INTO books (name, book_order, testament, author_id, category_id, slug) VALUES ($1, $2, $3, $4, $5, $6)', [name, order, testament, authorId, categoryId, await uniqueSlug(client, 'books', name, 'book')]);
    });
    res.redirect('/admin');
  } catch (error) {
    if (error.code === '23505') {
      options.error = 'That book name or order is already in use.';
      return res.status(409).render('book-form', options);
    }
    next(error);
  }
}
app.post('/admin/books/new', requireAdmin, saveBook);
app.post('/admin/books/:id/edit', requireAdmin, saveBook);
app.post('/admin/books/:id/delete', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  const result = id && await db.query('DELETE FROM books WHERE id = $1', [id]);
  if (!result || !result.rowCount) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  res.redirect('/admin');
});

app.get('/admin/books/:id/verses', requireAdmin, (req, res) => res.redirect(`/admin/books/${req.params.id}/chapters`));
app.get('/admin/books/:id/chapters', requireAdmin, async (req, res) => {
  const book = positiveInt(req.params.id) && await getBook(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  const chapters = (await db.query('SELECT * FROM chapters WHERE book_id = $1 ORDER BY number', [book.id])).rows;
  res.render('admin-chapters', { title: `Chapters — ${book.name}`, book, chapters });
});
app.get('/admin/books/:id/chapters/new', requireAdmin, async (req, res) => {
  const book = positiveInt(req.params.id) && await getBook(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  res.render('chapter-form', { title: 'Add chapter', book, chapter: { number: '', title: '', body: '' }, action: `/admin/books/${book.id}/chapters/new`, error: null });
});
app.get('/admin/books/:id/chapters/:chapterId/edit', requireAdmin, async (req, res) => {
  const book = positiveInt(req.params.id) && await getBook(req.params.id);
  const chapter = book && positiveInt(req.params.chapterId) && (await db.query('SELECT * FROM chapters WHERE id = $1 AND book_id = $2', [req.params.chapterId, book.id])).rows[0];
  if (!chapter) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  res.render('chapter-form', { title: 'Edit chapter', book, chapter, action: `/admin/books/${book.id}/chapters/${chapter.id}/edit`, error: null });
});
async function saveChapter(req, res, next) {
  const book = positiveInt(req.params.id) && await getBook(req.params.id);
  if (!book) return res.status(404).render('message', { title: 'Not found', message: 'Book not found.' });
  const editing = Boolean(req.params.chapterId);
  const existing = editing && positiveInt(req.params.chapterId) && (await db.query('SELECT id, title, slug FROM chapters WHERE id = $1 AND book_id = $2', [req.params.chapterId, book.id])).rows[0];
  if (editing && !existing) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  const number = positiveInt(req.body.number);
  const chapterTitle = typeof req.body.chapter_title === 'string' ? req.body.chapter_title.trim() : '';
  const body = typeof req.body.body === 'string' ? req.body.body : '';
  const options = { title: editing ? 'Edit chapter' : 'Add chapter', book, chapter: { number: req.body.number, title: chapterTitle, body }, action: req.path, error: null };
  if (!number || !chapterTitle || chapterTitle.length > 200 || !body.trim() || body.length > 120000) {
    options.error = 'Enter a chapter title (up to 200 characters), a positive chapter number and a body of up to 120,000 characters.';
    return res.status(400).render('chapter-form', options);
  }
  try {
    await withSlugTransaction(async client => {
      const slug = editing && existing.title ? existing.slug : await uniqueSlug(client, 'chapters', chapterTitle, `chapter-${number}`, book.id, existing?.id);
      if (editing) await client.query('UPDATE chapters SET number = $1, title = $2, body = $3, slug = $4 WHERE id = $5 AND book_id = $6', [number, chapterTitle, body, slug, existing.id, book.id]);
      else await client.query('INSERT INTO chapters (book_id, number, title, body, slug) VALUES ($1, $2, $3, $4, $5)', [book.id, number, chapterTitle, body, slug]);
    });
    res.redirect(`/admin/books/${book.id}/chapters`);
  } catch (error) {
    if (error.code === '23505') {
      options.error = 'That chapter number already exists in this book.';
      return res.status(409).render('chapter-form', options);
    }
    next(error);
  }
}
app.post('/admin/books/:id/chapters/new', requireAdmin, saveChapter);
app.post('/admin/books/:id/chapters/:chapterId/edit', requireAdmin, saveChapter);
app.post('/admin/books/:id/chapters/:chapterId/delete', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  const chapterId = positiveInt(req.params.chapterId);
  const result = id && chapterId && await db.query('DELETE FROM chapters WHERE id = $1 AND book_id = $2', [chapterId, id]);
  if (!result || !result.rowCount) return res.status(404).render('message', { title: 'Not found', message: 'Chapter not found.' });
  res.redirect(`/admin/books/${req.params.id}/chapters`);
});

app.use((req, res) => res.status(404).render('message', { title: 'Not found', message: 'Page not found.' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (error.type === 'entity.too.large') {
    return res.status(413).send('The submitted form is too large.');
  }
  res.status(500).render('message', { title: 'Error', message: 'Something went wrong. Please try again.' });
});
if (require.main === module) {
  const port = process.env.PORT || 3002;
  app.listen(port, process.env.HOST, () => console.log(`Muma Maler running at http://localhost:${port}`));
}
module.exports = app;
app.locals.db = db;
app.locals.sessionStore = sessionStore;
