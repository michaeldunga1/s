const { Pool } = require('pg');
const { hymnSlugBase } = require('./slugs');

class PostgresRepository {
  constructor(config) {
    this.pool = new Pool(config);
  }

  async close() {
    await this.pool.end();
  }

  async hymnsWithCategories() {
    const result = await this.pool.query(`
      SELECT h.id, h.slug, h.number, h.title, h.lyrics, h.legacy_url, h.composer,
             h.page_number, a.id AS author_id, a.name AS author,
             COALESCE(
               json_agg(json_build_object('id', c.id, 'name', c.name)
                        ORDER BY lower(c.name COLLATE "C"), c.id)
               FILTER (WHERE c.id IS NOT NULL), '[]'::json
             ) AS categories
      FROM hymns h
      LEFT JOIN authors a ON a.id = h.author_id
      LEFT JOIN hymn_categories hc ON hc.hymn_id = h.id
      LEFT JOIN categories c ON c.id = hc.category_id
      GROUP BY h.id, a.id
      ORDER BY h.number IS NULL, h.number, lower(h.title COLLATE "C")
    `);
    return result.rows;
  }

  async categories() {
    const result = await this.pool.query(`
      SELECT c.id, c.name, count(hc.hymn_id)::integer AS count
      FROM categories c LEFT JOIN hymn_categories hc ON hc.category_id = c.id
      GROUP BY c.id ORDER BY lower(c.name COLLATE "C"), c.id
    `);
    return result.rows;
  }

  async author(id) {
    const result = await this.pool.query('SELECT id, name FROM authors WHERE id = $1', [id]);
    return result.rows[0];
  }

  async hymnBySlug(slug) {
    const result = await this.pool.query(`
      SELECT h.*, a.name AS author
      FROM hymns h LEFT JOIN authors a ON a.id = h.author_id WHERE h.slug = $1
    `, [slug]);
    return result.rows[0];
  }

  async hymnById(id) {
    const result = await this.pool.query('SELECT id, slug FROM hymns WHERE id = $1', [id]);
    return result.rows[0];
  }

  async hymnForEdit(id) {
    const result = await this.pool.query(`
      SELECT h.*, a.name AS author FROM hymns h
      LEFT JOIN authors a ON a.id = h.author_id WHERE h.id = $1
    `, [id]);
    return result.rows[0];
  }

  async authors() {
    const result = await this.pool.query('SELECT name FROM authors ORDER BY lower(name COLLATE "C"), id');
    return result.rows;
  }

  async category(id) {
    const result = await this.pool.query('SELECT id, name FROM categories WHERE id = $1', [id]);
    return result.rows[0];
  }

  async createCategory(name) {
    const result = await this.pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    return result.rows[0];
  }

  async updateCategory(id, name) {
    const result = await this.pool.query('UPDATE categories SET name = $1 WHERE id = $2', [name, id]);
    return result.rowCount;
  }

  async deleteCategory(id) {
    const result = await this.pool.query('DELETE FROM categories WHERE id = $1', [id]);
    return result.rowCount;
  }

  async saveHymn(id, hymn, categoryIds) {
    const client = await this.pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      if (id !== null) {
        const existing = await client.query('SELECT id FROM hymns WHERE id = $1 FOR UPDATE', [id]);
        if (!existing.rowCount) {
          await client.query('COMMIT');
          return undefined;
        }
      }

      let authorId = null;
      if (hymn.author) {
        await client.query('INSERT INTO authors (name) VALUES ($1) ON CONFLICT DO NOTHING', [hymn.author]);
        const author = await client.query(
          'SELECT id FROM authors WHERE lower(name COLLATE "C") = lower($1 COLLATE "C")', [hymn.author]
        );
        authorId = author.rows[0].id;
      }

      const values = [hymn.number, hymn.title, hymn.lyrics, authorId, hymn.composer, hymn.pageNumber];
      let hymnId = id;
      if (id === null) {
        // Serialize slug allocation across concurrent creates.
        await client.query('SELECT pg_advisory_xact_lock(573239142)');
        const base = hymnSlugBase(hymn.title);
        let slug = base;
        let suffix = 2;
        while ((await client.query('SELECT 1 FROM hymns WHERE slug = $1', [slug])).rowCount) {
          slug = `${base}-${suffix++}`;
        }
        const inserted = await client.query(`
          INSERT INTO hymns (number, title, lyrics, author_id, composer, page_number, slug)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
        `, [...values, slug]);
        hymnId = inserted.rows[0].id;
      } else {
        await client.query(`
          UPDATE hymns SET number = $1, title = $2, lyrics = $3, author_id = $4, composer = $5, page_number = $6
          WHERE id = $7
        `, [...values, id]);
        await client.query('DELETE FROM hymn_categories WHERE hymn_id = $1', [id]);
      }
      for (const categoryId of categoryIds) {
        await client.query('INSERT INTO hymn_categories (hymn_id, category_id) VALUES ($1, $2)', [hymnId, categoryId]);
      }
      await client.query('COMMIT');
      return hymnId;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
        throw new AggregateError([error, rollbackError], 'Hymn save and rollback failed');
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async deleteHymn(id) {
    const result = await this.pool.query('DELETE FROM hymns WHERE id = $1', [id]);
    return result.rowCount;
  }

  async hymnCategories(id) {
    const result = await this.pool.query(`
      SELECT c.id, c.name FROM categories c
      JOIN hymn_categories hc ON hc.category_id = c.id WHERE hc.hymn_id = $1
      ORDER BY lower(c.name COLLATE "C"), c.id
    `, [id]);
    return result.rows;
  }

  async favoriteIds(userId) {
    const result = await this.pool.query('SELECT hymn_id FROM favorites WHERE user_id = $1', [userId]);
    return result.rows.map(row => row.hymn_id);
  }

  async bookmark(userId, hymnId) {
    const result = await this.pool.query(`
      SELECT h.id, h.slug, h.title, b.note, b.tags
      FROM bookmarks b JOIN hymns h ON h.id = b.hymn_id
      WHERE b.user_id = $1 AND b.hymn_id = $2
    `, [userId, hymnId]);
    return result.rows[0];
  }

  async bookmarks(userId) {
    const result = await this.pool.query(`
      SELECT h.id, h.slug, h.number, h.title, b.note, b.tags
      FROM bookmarks b JOIN hymns h ON h.id = b.hymn_id
      WHERE b.user_id = $1 ORDER BY h.number IS NULL, h.number, lower(h.title COLLATE "C")
    `, [userId]);
    return result.rows;
  }

  async userById(id) {
    const result = await this.pool.query('SELECT id, username, email, password_hash, role FROM users WHERE id = $1', [id]);
    return result.rows[0];
  }

  async userByEmail(email) {
    const result = await this.pool.query(`
      SELECT id, username, email, password_hash, role FROM users
      WHERE lower(email COLLATE "C") = lower($1 COLLATE "C")
    `, [email]);
    return result.rows[0];
  }

  async createUser(username, email, passwordHash, role = 'user') {
    const result = await this.pool.query(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES ($1, $2, $3, $4) RETURNING id, username, email, role
    `, [username, email, passwordHash, role]);
    return result.rows[0];
  }

  async updateUser(id, username, email) {
    const result = await this.pool.query('UPDATE users SET username = $1, email = $2 WHERE id = $3', [username, email, id]);
    return result.rowCount;
  }

  async deleteRegularUser(id) {
    const result = await this.pool.query("DELETE FROM users WHERE id = $1 AND role = 'user'", [id]);
    return result.rowCount;
  }

  async users() {
    const result = await this.pool.query(`
      SELECT id, username, email, role FROM users
      ORDER BY lower(COALESCE(email, username) COLLATE "C"), id
    `);
    return result.rows;
  }

  async addFavorite(userId, hymnId) {
    const result = await this.pool.query(`
      INSERT INTO favorites (user_id, hymn_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [userId, hymnId]);
    return result.rowCount;
  }

  async removeFavorite(userId, hymnId) {
    const result = await this.pool.query('DELETE FROM favorites WHERE user_id = $1 AND hymn_id = $2', [userId, hymnId]);
    return result.rowCount;
  }

  async addBookmark(userId, hymnId) {
    const result = await this.pool.query(`
      INSERT INTO bookmarks (user_id, hymn_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [userId, hymnId]);
    return result.rowCount;
  }

  async removeBookmark(userId, hymnId) {
    const result = await this.pool.query('DELETE FROM bookmarks WHERE user_id = $1 AND hymn_id = $2', [userId, hymnId]);
    return result.rowCount;
  }

  async updateBookmark(userId, hymnId, note, tags) {
    const result = await this.pool.query(`
      UPDATE bookmarks SET note = $1, tags = $2 WHERE user_id = $3 AND hymn_id = $4
    `, [note, tags, userId, hymnId]);
    return result.rowCount;
  }
}

module.exports = { PostgresRepository };
