const express = require('express');
const db = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

for (const [url, title, page] of [
  ['/privacy', 'Privacy policy', 'privacy'],
  ['/terms', 'Terms of use', 'terms'],
  ['/cookies', 'Cookie and storage notice', 'cookies']
]) {
  router.get(url, (req, res) => res.render('legal', { title, page }));
}

// View the current user's profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT username, email, role, created_at
      FROM users
      WHERE id = $1
    `, [req.session.user_id]);
    const profile = rows[0];

    if (!profile) {
      return res.status(404).render('error', { message: 'Profile not found' });
    }

    res.render('profile', {
      title: 'My Profile',
      profile
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'Failed to load profile' });
  }
});

// Home page - list all words
router.get('/', async (req, res) => {
  try {
    if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).send('Invalid search query.');
    const query = (req.query.q || '').trim();
    if (query.length > 200) return res.status(400).send('Search query must be at most 200 characters.');
    const normalized = query.toLocaleLowerCase();
    const result = await db.query(`
      SELECT id, word, definition FROM words ORDER BY word ASC
    `);
    const words = result.rows.filter(word => !normalized || [word.word, word.definition].some(value => value.toLocaleLowerCase().includes(normalized)));

    res.render('index', {
      words,
      query,
      title: 'Luo to English Dictionary'
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', {
      message: 'Failed to load words'
    });
  }
});

// View word with its definition and comments
router.get('/word/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id) || Number(req.params.id) > 2147483647) {
      return res.status(404).render('error', { message: 'Word not found' });
    }
    const word = (await db.query('SELECT * FROM words WHERE id = $1', [req.params.id])).rows[0];
    if (!word) {
      return res.status(404).render('error', { message: 'Word not found' });
    }

    const comments = (await db.query(`
        SELECT 
          c.*,
          u.username,
          COALESCE(SUM(v.value), 0) as score,
          COALESCE(MAX(CASE WHEN v.user_id = $2 THEN v.value END), 0) AS "userVote"
        FROM comments c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN votes v ON c.id = v.comment_id
        WHERE c.word_id = $1
        GROUP BY c.id, u.username
        ORDER BY score DESC, c.created_at DESC
      `, [word.id, req.session.user_id || null])).rows;

    res.render('word-detail', {
      word,
      comments,
      title: `${word.word} - Luo to English`
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', {
      message: 'Failed to load word details'
    });
  }
});

module.exports = router;
