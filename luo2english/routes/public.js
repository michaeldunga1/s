const express = require('express');
const db = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { parsePage, paginate } = require('../lib/pagination');
const router = express.Router();

// XML sitemap for public dictionary content.
router.get('/sitemap.xml', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, updated_at FROM words ORDER BY id ASC'
    );

    const baseUrl = 'https://swiftener.com';
    const entries = [
      { path: '/', changefreq: 'daily', priority: '1.0' },
      { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
      { path: '/terms', changefreq: 'yearly', priority: '0.3' },
      { path: '/cookies', changefreq: 'yearly', priority: '0.3' },
      ...rows.map(row => ({
        path: `/word/${row.id}`,
        changefreq: 'monthly',
        priority: '0.8',
        lastmod: row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : null
      }))
    ];

    const xmlUrls = entries.map(entry => `
  <url>
    <loc>${baseUrl}${entry.path}</loc>${entry.lastmod ? `
    <lastmod>${entry.lastmod}</lastmod>` : ''}
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${xmlUrls}
</urlset>`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (error) {
    console.error('Sitemap generation failed:', error);
    res.status(500).type('text/plain').send('Unable to generate sitemap');
  }
});

for (const [url, title, page, description] of [
  ['/privacy', 'Privacy policy', 'privacy', 'How Luo2English handles account information, comments, and operational data.'],
  ['/terms', 'Terms of use', 'terms', 'The rules for using the Luo2English dictionary and community features.'],
  ['/cookies', 'Cookie and storage notice', 'cookies', 'How Luo2English uses cookies and browser storage for sign-in and core features.']
]) {
  router.get(url, (req, res) => res.render('legal', {
    title,
    page,
    description,
    canonicalUrl: `https://swiftener.com${url}`
  }));
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

// Home page - list words with search and pagination
router.get('/', async (req, res) => {
  try {
    if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).send('Invalid search query.');
    const query = (req.query.q || '').trim();
    if (query.length > 200) return res.status(400).send('Search query must be at most 200 characters.');
    const pageSize = 24;
    const page = parsePage(req.query.page);
    const params = [];
    let where = '';
    if (query) {
      params.push(query);
      where = 'WHERE position(lower($1) in lower(word)) > 0 OR position(lower($1) in lower(definition)) > 0';
    }

    const { rows: [{ n: totalItems }] } = await db.query(`SELECT count(*)::int AS n FROM words ${where}`, params);
    const pager = paginate({ page, pageSize, totalItems });
    const result = await db.query(
      `SELECT id, word, definition FROM words ${where} ORDER BY word ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, pager.offset]
    );
    const pageUrl = targetPage => {
      const search = new URLSearchParams();
      if (query) search.set('q', query);
      if (targetPage > 1) search.set('page', String(targetPage));
      const suffix = search.toString();
      return suffix ? `/?${suffix}` : '/';
    };

    res.render('index', {
      words: result.rows,
      query,
      pagination: pager,
      pageUrl,
      title: 'Luo to English Dictionary | Luo2English',
      metaDescription: 'Explore the Luo to English dictionary. Search Dholuo words, discover English meanings, and learn with a community of speakers.',
      canonicalUrl: 'https://swiftener.com/',
      robots: req.query.q !== undefined ? 'noindex,follow' : 'index,follow'
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

    const plainDefinition = String(word.definition || '').replace(/\s+/g, ' ').trim();
    const metaDescription = (
      plainDefinition
        ? `${word.word}: ${plainDefinition}`
        : `Learn the meaning of the Luo word ${word.word} in the Luo to English dictionary.`
    ).slice(0, 160);

    const canonicalUrl = `https://swiftener.com/word/${word.id}`;

    const structuredData = JSON.stringify([
      {
        '@context': 'https://schema.org',
        '@type': 'DefinedTerm',
        name: word.word,
        description: plainDefinition || metaDescription,
        inDefinedTermSet: {
          '@type': 'DefinedTermSet',
          name: 'Luo to English Dictionary',
          url: 'https://swiftener.com/'
        },
        url: canonicalUrl
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Dictionary', item: 'https://swiftener.com/' },
          { '@type': 'ListItem', position: 2, name: word.word, item: canonicalUrl }
        ]
      }
    ]).replace(/</g, '\\u003c');

    res.render('word-detail', {
      word,
      comments,
      title: `${word.word} - Luo to English Dictionary | Luo2English`,
      metaDescription,
      canonicalUrl,
      structuredData
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', {
      message: 'Failed to load word details'
    });
  }
});

module.exports = router;
