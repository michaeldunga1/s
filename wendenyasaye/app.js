const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeEmail, isValidEmail } = require('./account');
const { composerNames } = require('./composers');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const repository = new (require('./postgres-repository').PostgresRepository)({ connectionString: process.env.DATABASE_URL });

function isUniqueViolation(error) {
  return error.code === '23505';
}

const app = express();
if (process.env.TRUST_PROXY === 'loopback') app.set('trust proxy', 'loopback');
const reference = 'https://www.mysongbooks.scaptedesigns.com/library/wende-nyasaye/';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '300kb' }));
const sessionStore = new (require('connect-pg-simple')(session))({ pool: repository.pool, createTableIfMissing: true });
app.use(session({
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
function accountKey(user) {
  return crypto.createHmac('sha256', sessionSecret).update(user.password_hash).digest('hex');
}
function signIn(req, res, next, user) {
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.user = { id: user.id, email: user.email, role: user.role, accountKey: accountKey(user) };
    req.session.save(error => {
      if (error) return next(error);
      res.redirect('/');
    });
  });
}
app.use(async (req, res, next) => {
  if (req.session.user) {
    const account = await repository.userById(req.session.user.id);
    if (!account || req.session.user.accountKey !== accountKey(account)) {
      if (req.path === '/api/hymns') return res.status(401).send('Session expired. Reload the page.');
      return req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie('connect.sid');
        res.redirect('/?signed_out=1');
      });
    }
    req.session.user.role = account.role;
    req.session.user.email = account.email;
  }
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.user || null;
  res.locals.reference = reference;
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return next();
  const supplied = req.body?._csrf;
  if (typeof supplied !== 'string' || supplied !== req.session.csrf) {
    return res.status(403).send('Invalid or expired form. Reload the page and try again.');
  }
  next();
});
app.param('id', (req, res, next, value) => {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
    return res.status(404).send('Not found.');
  }
  next();
});

function requireUser(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).send('Admin access required.');
  next();
}

function userInput(req) {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  return { email, password };
}

function validateHymn(body, allowEmptyLyrics) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const numberText = typeof body.number === 'string' ? body.number.trim() : '';
  const number = numberText ? Number(numberText) : null;
  const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const composer = typeof body.composer === 'string' ? body.composer.trim() : '';
  const pageText = typeof body.page_number === 'string' ? body.page_number.trim() : '';
  const pageNumber = pageText ? Number(pageText) : null;
  if (!title || title.length > 200) return { error: 'Enter a title of up to 200 characters.' };
  if ((!lyrics && !allowEmptyLyrics) || lyrics.length > 50000) return { error: 'Enter lyrics of up to 50,000 characters.' };
  if (author.length > 200) return { error: 'Author must be at most 200 characters.' };
  if (composer.length > 500) return { error: 'Composer must be at most 500 characters.' };
  if (numberText && (!/^[0-9]+$/.test(numberText) || !Number.isSafeInteger(number) || number < 1)) {
    return { error: 'Hymn number must be a positive whole number.' };
  }
  if (pageText && (!/^[0-9]+$/.test(pageText) || !Number.isSafeInteger(pageNumber) || pageNumber < 1)) {
    return { error: 'Page number must be a positive whole number.' };
  }
  return { title, number, lyrics, author, composer, pageNumber };
}

for (const [url, title, page] of [
  ['/privacy', 'Privacy policy', 'privacy'],
  ['/terms', 'Terms of use', 'terms'],
  ['/cookies', 'Cookie and storage notice', 'cookies']
]) {
  app.get(url, (req, res) => res.render('legal', { title, page }));
}
function directorySearch(req, res, next) {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).send('Invalid search query.');
  const query = (req.query.q || '').trim();
  if (query.length > 200) return res.status(400).send('Search query must be at most 200 characters.');
  res.locals.directoryQuery = query;
  next();
}

function renderDirectory(res, title, kind, items) {
  const query = res.locals.directoryQuery;
  const needle = query.toLocaleLowerCase();
  const matches = items.filter(item => item.name.toLocaleLowerCase().includes(needle));
  res.render('browse-categories', { title, kind, items: matches, query });
}

app.get('/composers', directorySearch, async (req, res) => {
  if (req.query.name !== undefined && typeof req.query.name !== 'string') return res.status(400).send('Invalid composer.');
  const name = (req.query.name || '').trim();
  if (name.length > 500) return res.status(400).send('Invalid composer.');
  const hymns = await repository.hymnsWithCategories();
  if (name) {
    const matches = hymns.filter(hymn => composerNames(hymn.composer).some(composer => composer.toLocaleLowerCase() === name.toLocaleLowerCase()));
    if (!matches.length) return res.status(404).send('Composer not found.');
    const displayName = composerNames(matches[0].composer).find(composer => composer.toLocaleLowerCase() === name.toLocaleLowerCase());
    return res.render('hymn-group', { title: displayName, heading: 'Composer', hymns: matches, composerNames });
  }
  const composers = new Map();
  for (const hymn of hymns) {
    for (const composer of composerNames(hymn.composer)) {
      const key = composer.toLocaleLowerCase();
      if (!composers.has(key)) composers.set(key, { name: composer, count: 0 });
      composers.get(key).count++;
    }
  }
  const items = [...composers.values()].sort((a, b) => a.name.localeCompare(b.name));
  renderDirectory(res, 'Composers', 'composer', items);
});
app.get('/categories', directorySearch, async (req, res) => {
  const items = await repository.categories();
  renderDirectory(res, 'Categories', 'category', items);
});
app.get('/authors/:id', async (req, res) => {
  const author = await repository.author(req.params.id);
  if (!author) return res.status(404).send('Author not found.');
  const hymns = (await repository.hymnsWithCategories()).filter(hymn => hymn.author_id === author.id);
  res.render('hymn-group', { title: author.name, heading: 'Author', hymns, composerNames });
});

app.get('/', async (req, res) => {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).send('Invalid search query.');
  const query = (req.query.q || '').trim();
  if (query.length > 200) return res.status(400).send('Search query must be at most 200 characters.');
  const categories = await repository.categories();
  const selectedCategory = typeof req.query.category === 'string' ? req.query.category : '';
  if (selectedCategory && !categories.some(category => String(category.id) === selectedCategory)) {
    return res.status(404).send('Category not found.');
  }
  const needle = query.toLocaleLowerCase();
  const hymns = (await repository.hymnsWithCategories()).filter(hymn =>
    (!selectedCategory || hymn.categories.some(category => String(category.id) === selectedCategory)) &&
    (!needle || [hymn.title, hymn.number, hymn.page_number, hymn.author, hymn.composer, hymn.lyrics, ...hymn.categories.map(category => category.name)]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(needle))));
  const favorites = req.session.user
    ? await repository.favoriteIds(req.session.user.id)
    : [];
  res.render('index', { title: 'Hymns', hymns, favorites, categories, selectedCategory, query, composerNames });
});

app.get('/api/hymns', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.json(await repository.hymnsWithCategories());
});

app.get('/hymns/:slug', async (req, res) => {
  if (/^\d+$/.test(req.params.slug)) {
    const id = Number(req.params.slug);
    const hymn = Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? await repository.hymnById(id) : null;
    if (!hymn) return res.status(404).send('Hymn not found.');
    return res.redirect(`/hymns/${encodeURIComponent(hymn.slug)}`);
  }
  const hymn = await repository.hymnBySlug(req.params.slug);
  if (!hymn) return res.status(404).send('Hymn not found.');
  const bookmark = req.session.user
    ? await repository.bookmark(req.session.user.id, hymn.id)
    : null;
  const categories = await repository.hymnCategories(hymn.id);
  res.render('hymn', { title: hymn.title, hymn, bookmark, categories, composerNames });
});

app.get('/register', (req, res) => res.render('auth', { title: 'Create account', action: '/register', error: null }));
app.post('/register', async (req, res, next) => {
  const { email, password } = userInput(req);
  if (!isValidEmail(email) || password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).render('auth', { title: 'Create account', action: '/register', error: 'Enter a valid email address and a password of at least 8 characters and at most 72 bytes.' });
  }
  try {
    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await repository.createUser(email, email, passwordHash);
    signIn(req, res, next, { ...result, password_hash: passwordHash });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).render('auth', { title: 'Create account', action: '/register', error: 'That email is already in use.' });
    }
    next(error);
  }
});

app.get('/login', (req, res) => res.render('auth', { title: 'Sign in', action: '/login', error: null }));
app.post('/login', async (req, res, next) => {
  const { email, password } = userInput(req);
  const user = await repository.userByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('auth', { title: 'Sign in', action: '/login', error: 'Invalid email or password.' });
  }
  signIn(req, res, next, user);
});
app.post('/logout', requireUser, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.redirect('/?signed_out=1');
  });
});

app.get('/profile', requireUser, async (req, res) => {
  const bookmarks = await repository.bookmarks(req.session.user.id);
  res.render('profile', { title: 'Profile', bookmarks });
});

app.get('/profile/edit', requireUser, (req, res) => {
  res.render('profile-edit', { title: 'Edit profile', email: req.session.user.email, error: null });
});
app.post('/profile/edit', requireUser, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const account = await repository.userById(req.session.user.id);
  const renderError = (status, error) => res.status(status).render('profile-edit', { title: 'Edit profile', email, error });
  if (!isValidEmail(email)) return renderError(400, 'Enter a valid email address.');
  if (Buffer.byteLength(password) > 72 || !bcrypt.compareSync(password, account.password_hash)) {
    return renderError(400, 'Incorrect password. Your profile was not changed.');
  }
  try {
    const username = normalizeEmail(account.username) === normalizeEmail(account.email) ? email : account.username;
    await repository.updateUser(req.session.user.id, username, email);
  } catch (error) {
    if (isUniqueViolation(error)) return renderError(409, 'That email is already in use.');
    return next(error);
  }
  req.session.user.email = email;
  res.redirect('/profile');
});

app.get('/profile/delete', requireUser, (req, res) => {
  if (req.session.user.role !== 'user') return res.status(403).send('Administrator accounts cannot be deleted here.');
  res.render('profile-delete', { title: 'Delete account', error: null });
});
app.post('/profile/delete', requireUser, async (req, res, next) => {
  if (req.session.user.role !== 'user') return res.status(403).send('Administrator accounts cannot be deleted here.');
  const account = await repository.userById(req.session.user.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (Buffer.byteLength(password) > 72 || !bcrypt.compareSync(password, account.password_hash)) {
    return res.status(400).render('profile-delete', { title: 'Delete account', error: 'Incorrect password. Your account was not deleted.' });
  }
  if (req.body.confirm !== 'delete') {
    return res.status(400).render('profile-delete', { title: 'Delete account', error: 'Confirm that you want to permanently delete your account.' });
  }
  await repository.deleteRegularUser(req.session.user.id);
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('connect.sid');
    res.redirect('/?signed_out=1');
  });
});

app.post('/bookmarks/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const hymn = Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? await repository.hymnById(id) : null;
  if (!hymn) {
    return res.status(404).send('Hymn not found.');
  }
  if (req.body.action === 'add') {
    await repository.addBookmark(req.session.user.id, id);
  } else if (req.body.action === 'remove') {
    await repository.removeBookmark(req.session.user.id, id);
  } else {
    return res.status(400).send('Invalid bookmark action.');
  }
  res.redirect(req.body.from === 'profile' ? '/profile' : `/hymns/${encodeURIComponent(hymn.slug)}`);
});

app.get('/bookmarks/:id/edit', requireUser, async (req, res) => {
  const bookmark = await repository.bookmark(req.session.user.id, req.params.id);
  if (!bookmark) return res.status(404).send('Bookmark not found.');
  res.render('bookmark-form', { title: 'Edit bookmark', bookmark, error: null });
});
app.post('/bookmarks/:id/edit', requireUser, async (req, res) => {
  const bookmark = await repository.bookmark(req.session.user.id, req.params.id);
  if (!bookmark) return res.status(404).send('Bookmark not found.');
  const note = typeof req.body.note === 'string' ? req.body.note : '';
  const tags = typeof req.body.tags === 'string' ? req.body.tags : '';
  if (typeof req.body.note !== 'string' || typeof req.body.tags !== 'string' || note.length > 5000 || tags.length > 500) {
    return res.status(400).render('bookmark-form', { title: 'Edit bookmark', bookmark: { ...bookmark, note, tags }, error: 'Notes must be at most 5,000 characters and tags at most 500 characters.' });
  }
  await repository.updateBookmark(req.session.user.id, bookmark.id, note, tags);
  res.redirect('/profile');
});

app.post('/favorites/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647 || !await repository.hymnById(id)) {
    return res.status(404).send('Hymn not found.');
  }
  if (req.body.action === 'add') {
    await repository.addFavorite(req.session.user.id, id);
  } else if (req.body.action === 'remove') {
    await repository.removeFavorite(req.session.user.id, id);
  } else {
    return res.status(400).send('Invalid favorite action.');
  }
  res.redirect('/');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const hymns = await repository.hymnsWithCategories();
  res.render('admin', { title: 'Manage hymns', hymns, composerNames });
});
async function renderCategories(res, status, error, name = '') {
  const categories = (await repository.categories()).map(category => ({ ...category, hymn_count: category.count }));
  return res.status(status).render('admin-categories', { title: 'Manage categories', categories, error, name });
}
app.get('/admin/categories', requireAdmin, (req, res) => renderCategories(res, 200, null));
app.post('/admin/categories', requireAdmin, async (req, res, next) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) return renderCategories(res, 400, 'Enter a category name of up to 100 characters.', name);
  try {
    await repository.createCategory(name);
    res.redirect('/admin/categories');
  } catch (error) {
    if (isUniqueViolation(error)) return renderCategories(res, 409, 'That category already exists.', name);
    next(error);
  }
});
app.get('/admin/categories/:id/edit', requireAdmin, async (req, res) => {
  const category = await repository.category(req.params.id);
  if (!category) return res.status(404).send('Category not found.');
  res.render('category-form', { title: 'Edit category', category, error: null });
});
app.post('/admin/categories/:id/edit', requireAdmin, async (req, res, next) => {
  const category = await repository.category(req.params.id);
  if (!category) return res.status(404).send('Category not found.');
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const fail = (status, error) => res.status(status).render('category-form', { title: 'Edit category', category: { ...category, name }, error });
  if (!name || name.length > 100) return fail(400, 'Enter a category name of up to 100 characters.');
  try {
    await repository.updateCategory(category.id, name);
    res.redirect('/admin/categories');
  } catch (error) {
    if (isUniqueViolation(error)) return fail(409, 'That category already exists.');
    next(error);
  }
});
app.get('/admin/categories/:id/delete', requireAdmin, async (req, res) => {
  const category = await repository.category(req.params.id);
  if (!category) return res.status(404).send('Category not found.');
  res.render('category-delete', { title: 'Delete category', category });
});
app.post('/admin/categories/:id/delete', requireAdmin, async (req, res) => {
  if (req.body.confirm !== 'delete') return res.status(400).send('Confirm that you want to delete this category.');
  const changes = await repository.deleteCategory(req.params.id);
  if (!changes) return res.status(404).send('Category not found.');
  res.redirect('/admin/categories');
});
app.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await repository.users();
  res.render('admin-users', { title: 'Users', users });
});
app.get('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  const account = await repository.userById(req.params.id);
  if (!account || account.role !== 'user') return res.status(404).send('User not found or cannot be deleted.');
  res.render('admin-delete-user', { title: 'Delete user', account, accountToken: accountKey(account), error: null });
});
app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  const account = await repository.userById(req.params.id);
  if (!account || account.role !== 'user') return res.status(404).send('User not found or cannot be deleted.');
  const token = accountKey(account);
  if (req.body.accountToken !== token) return res.status(409).send('This account has changed. Return to the user list and try again.');
  if (req.body.confirm !== 'delete') {
    return res.status(400).render('admin-delete-user', { title: 'Delete user', account, accountToken: token, error: 'Confirm that you want to permanently delete this user.' });
  }
  await repository.deleteRegularUser(account.id);
  res.redirect('/admin/users');
});
app.get('/admin/hymns/new', requireAdmin, async (req, res) => {
  res.render('hymn-form', { title: 'Add hymn', hymn: { title: '', number: '', lyrics: '', author: '', composer: '', page_number: '' }, authors: await repository.authors(), categories: await repository.categories(), selectedCategories: [], action: '/admin/hymns/new', error: null, allowEmptyLyrics: false });
});
app.get('/admin/hymns/:id/edit', requireAdmin, async (req, res) => {
  const hymn = await repository.hymnForEdit(req.params.id);
  if (!hymn) return res.status(404).send('Hymn not found.');
  const selectedCategories = (await repository.hymnCategories(hymn.id)).map(row => String(row.id));
  res.render('hymn-form', { title: 'Edit hymn', hymn, authors: await repository.authors(), categories: await repository.categories(), selectedCategories, action: `/admin/hymns/${hymn.id}/edit`, error: null, allowEmptyLyrics: !hymn.lyrics.trim() });
});
async function saveHymn(req, res, next) {
  const editing = Boolean(req.params.id);
  const existing = editing ? await repository.hymnForEdit(req.params.id) : null;
  if (editing && !existing) return res.status(404).send('Hymn not found.');
  const allowEmptyLyrics = Boolean(existing && !existing.lyrics.trim());
  const hymn = validateHymn(req.body, allowEmptyLyrics);
  const categories = await repository.categories();
  const submitted = req.body.categories === undefined ? [] : Array.isArray(req.body.categories) ? req.body.categories : [req.body.categories];
  const selectedCategories = submitted.filter(value => typeof value === 'string');
  const validCategories = selectedCategories.length === submitted.length && new Set(selectedCategories).size === selectedCategories.length &&
    selectedCategories.every(value => categories.some(category => String(category.id) === value));
  const options = { title: editing ? 'Edit hymn' : 'Add hymn', action: req.path, hymn: req.body, authors: await repository.authors(), categories, selectedCategories, error: hymn.error || (!validCategories ? 'Choose valid categories.' : null), allowEmptyLyrics };
  if (options.error) return res.status(400).render('hymn-form', options);
  try {
    const saved = await repository.saveHymn(editing ? existing.id : null, hymn, selectedCategories);
    if (saved === undefined) return res.status(404).send('Hymn not found.');
    res.redirect('/admin');
  } catch (error) {
    if (isUniqueViolation(error)) {
      options.error = 'That hymn number is already in use.';
      return res.status(409).render('hymn-form', options);
    }
    next(error);
  }
}
app.post('/admin/hymns/new', requireAdmin, saveHymn);
app.post('/admin/hymns/:id/edit', requireAdmin, saveHymn);
app.get('/admin/hymns/:id/delete', requireAdmin, async (req, res) => {
  const hymn = await repository.hymnForEdit(req.params.id);
  if (!hymn) return res.status(404).send('Hymn not found.');
  res.render('delete-hymn', { title: 'Delete hymn', hymn });
});
app.post('/admin/hymns/:id/delete', requireAdmin, async (req, res) => {
  const changes = await repository.deleteHymn(req.params.id);
  if (!changes) return res.status(404).send('Hymn not found.');
  res.redirect('/admin');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, process.env.HOST, () => console.log(`Wende Nyasaye running at http://localhost:${port}`));
}
module.exports = app;
app.locals.repository = repository;
app.locals.sessionStore = sessionStore;
