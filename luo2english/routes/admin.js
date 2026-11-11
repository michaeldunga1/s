const express = require('express');
const db = require('../db/postgres');
const { requireAdmin } = require('../middleware/auth');
const crypto = require('node:crypto');
const router = express.Router();

router.use(requireAdmin);
for (const param of ['id', 'word_id']) {
  router.param(param, (req, res, next, value) => {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2147483647) {
      return res.status(404).render('error', { message: 'Not found' });
    }
    next();
  });
}

router.get('/', async (req, res) => {
  try {
    const { rows: [stats] } = await db.query(`
      SELECT (SELECT count(*) FROM words) AS "totalWords",
             (SELECT count(*) FROM words WHERE trim(definition) <> '') AS "totalDefinitions",
             (SELECT count(*) FROM users) AS "totalUsers",
             (SELECT count(*) FROM comments) AS "totalComments"
    `);
    res.render('admin-dashboard', {
      title: 'Admin Dashboard',
      stats
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to load dashboard' });
  }
});

router.get('/schema', async (req, res) => {
  try {
    const { rows: objects } = await db.query(`
      SELECT 'table' AS type, c.relname AS name, c.relname AS tbl_name,
        string_agg(format('%I %s%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END), E'\\n' ORDER BY a.attnum) AS sql
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      GROUP BY c.oid, c.relname
      UNION ALL
      SELECT 'index', i.relname, t.relname, pg_catalog.pg_get_indexdef(i.oid)
      FROM pg_catalog.pg_class i JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
      JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
      UNION ALL
      SELECT 'constraint', con.conname, c.relname, pg_catalog.pg_get_constraintdef(con.oid)
      FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
      UNION ALL
      SELECT 'trigger', tr.tgname, c.relname, pg_catalog.pg_get_triggerdef(tr.oid)
      FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_class c ON c.oid = tr.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND NOT tr.tgisinternal
      UNION ALL
      SELECT 'function', p.proname, '-', pg_catalog.pg_get_functiondef(p.oid)
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema() AND p.prokind = 'f'
      ORDER BY type, name
    `);
    res.render('admin-schema', { title: 'Database Schema', objects });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to load database schema' });
  }
});

router.get('/users', async (req, res) => {
  const { rows: users } = await db.query('SELECT id, username, email, role FROM users ORDER BY lower(username COLLATE "C"), id');
  res.render('admin-users', { title: 'Users', users });
});

router.get('/users/:id/delete', async (req, res) => {
  const account = (await db.query("SELECT id, username, email FROM users WHERE id = $1 AND role = 'user'", [req.params.id])).rows[0];
  if (!account) return res.status(404).render('error', { message: 'User not found or cannot be deleted.' });
  if (!req.session.deleteUserToken) req.session.deleteUserToken = crypto.randomBytes(32).toString('hex');
  res.render('admin-delete-user', { title: 'Delete User', account, token: req.session.deleteUserToken, error: null });
});

router.post('/users/:id/delete', async (req, res) => {
  if (typeof req.body?._csrf !== 'string' || !req.session.deleteUserToken || req.body._csrf !== req.session.deleteUserToken) {
    return res.status(403).render('error', { message: 'Invalid or expired form. Reload the page and try again.' });
  }
  const account = (await db.query("SELECT id, username, email FROM users WHERE id = $1 AND role = 'user'", [req.params.id])).rows[0];
  if (!account) return res.status(404).render('error', { message: 'User not found or cannot be deleted.' });
  if (req.body.confirm !== 'delete') {
    return res.status(400).render('admin-delete-user', { title: 'Delete User', account, token: req.session.deleteUserToken, error: 'Confirm that you want to permanently delete this user.' });
  }
  await db.query("DELETE FROM users WHERE id = $1 AND role = 'user'", [account.id]);
  res.redirect('/admin/users');
});

router.get('/words', async (req, res) => {
  try {
    const { rows: words } = await db.query('SELECT id, word, definition FROM words ORDER BY word ASC');
    res.render('admin-words', { title: 'Manage Words', words });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to load words' });
  }
});

router.get('/words/new', (req, res) => {
  res.render('admin-word-form', { title: 'Add Word', word: null, errors: [] });
});

router.get('/words/:id/edit', async (req, res) => {
  try {
    const word = (await db.query('SELECT * FROM words WHERE id = $1', [req.params.id])).rows[0];
    if (!word) return res.status(404).render('error', { message: 'Word not found' });
    res.render('admin-word-form', { title: 'Edit Word', word, errors: [] });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to load word' });
  }
});

async function saveWord(req, res, next) {
  const editing = Boolean(req.params.id);
  const word = typeof req.body.word === 'string' ? req.body.word.trim().toLowerCase() : '';
  const definition = typeof req.body.definition === 'string' ? req.body.definition.trim() : '';
  const input = { id: req.params.id, word, definition };
  const title = editing ? 'Edit Word' : 'Add Word';
  if (!word) return res.status(400).render('admin-word-form', { title, word: input, errors: ['Word is required'] });
  try {
    if (editing) {
      const result = await db.query('UPDATE words SET word = $1, definition = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [word, definition, req.params.id]);
      if (!result.rowCount) return res.status(404).render('error', { message: 'Word not found' });
    } else {
      await db.query('INSERT INTO words (word, definition) VALUES ($1, $2)', [word, definition]);
    }
    res.redirect('/admin/words');
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).render('admin-word-form', { title, word: input, errors: ['Word already exists'] });
    }
    next(error);
  }
}

router.post('/words', saveWord);
router.post('/words/:id', saveWord);

router.post('/words/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM words WHERE id = $1', [req.params.id]);
    res.redirect('/admin/words');
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to delete word' });
  }
});

router.get('/words/:word_id/definitions', (req, res) => res.redirect(`/admin/words/${req.params.word_id}/edit`));

module.exports = router;
