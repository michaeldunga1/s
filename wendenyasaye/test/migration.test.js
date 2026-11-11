const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('legacy links and favorites survive the hymn schema migration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wende-migration-'));
  const file = path.join(directory, 'legacy.db');
  try {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE hymns (id INTEGER PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL);
      CREATE TABLE favorites (user_id INTEGER NOT NULL REFERENCES users(id), hymn_id INTEGER NOT NULL REFERENCES hymns(id), PRIMARY KEY(user_id, hymn_id));
      CREATE TABLE bookmarks (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, hymn_id INTEGER NOT NULL REFERENCES hymns(id) ON DELETE CASCADE, PRIMARY KEY(user_id, hymn_id));
      INSERT INTO users VALUES (1, 'user', 'hash', 'user');
      INSERT INTO hymns VALUES (4, 12, 'Existing hymn', 'https://www.mysongbooks.scaptedesigns.com/library/wende-nyasaye/existing');
      INSERT INTO hymns VALUES (6, 14, 'Existing Hymn!', 'https://example.test/a');
      INSERT INTO hymns VALUES (7, 15, '123', 'https://example.test/b');
      INSERT INTO hymns VALUES (8, 16, 'Praise and Worship', 'https://example.test/c');
      INSERT INTO favorites VALUES (1, 4);
      INSERT INTO bookmarks VALUES (1, 4);
    `);
    legacy.close();
    const result = spawnSync(process.execPath, ['-e', "const db = require('./db'); console.log(JSON.stringify({ hymn: db.prepare('SELECT * FROM hymns').get(), favorite: db.prepare('SELECT * FROM favorites').get(), violations: db.pragma('foreign_key_check') }));"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: file },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const migrated = JSON.parse(result.stdout);
    assert.equal(migrated.hymn.id, 4);
    assert.equal(migrated.hymn.lyrics, '');
    assert.equal(migrated.hymn.composer, '');
    assert.equal(migrated.hymn.page_number, null);
    assert.equal(migrated.hymn.slug, 'existing-hymn');
    assert.match(migrated.hymn.legacy_url, /existing$/);
    assert.equal(migrated.favorite.hymn_id, 4);
    assert.deepEqual(migrated.violations, []);
    const updated = new Database(file);
    updated.pragma('foreign_keys = ON');
    assert.deepEqual(updated.prepare('SELECT user_id, hymn_id, note, tags FROM bookmarks').get(), { user_id: 1, hymn_id: 4, note: '', tags: '' });
    assert.deepEqual(updated.prepare('SELECT slug FROM hymns ORDER BY id').all(), [
      { slug: 'existing-hymn' }, { slug: 'existing-hymn-2' }, { slug: 'hymn-123' }, { slug: 'praise-and-worship' }
    ]);
    assert.deepEqual(updated.prepare('SELECT c.name FROM hymn_categories hc JOIN categories c ON c.id = hc.category_id WHERE hc.hymn_id = 8 ORDER BY c.name').all(), [{ name: 'Praise' }, { name: 'Worship' }]);
    assert.equal(updated.prepare('SELECT count(*) n FROM hymn_categories WHERE hymn_id = 4').get().n, 0);
    updated.exec("DELETE FROM hymn_categories WHERE hymn_id = 8; DELETE FROM categories WHERE name = 'Praise'");
    updated.exec(`
      INSERT INTO users (id, username, password_hash, role) VALUES (2, 'bookmark-user', 'hash', 'user');
      INSERT INTO hymns (id, number, title, lyrics, slug) VALUES (5, 13, 'Bookmark hymn', '', 'bookmark-hymn');
      INSERT INTO bookmarks (user_id, hymn_id) VALUES (2, 4), (1, 5);
      DELETE FROM users WHERE id = 2;
      DELETE FROM hymns WHERE id = 5;
    `);
    assert.equal(updated.prepare('SELECT count(*) AS count FROM bookmarks').get().count, 1);
    assert.deepEqual(updated.pragma('foreign_key_check'), []);
    updated.close();
    const rerun = spawnSync(process.execPath, ['-e', "require('./db').close()"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: file },
      encoding: 'utf8'
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    const reopened = new Database(file);
    assert.deepEqual(reopened.prepare('SELECT slug FROM hymns ORDER BY id').all(), [
      { slug: 'existing-hymn' }, { slug: 'existing-hymn-2' }, { slug: 'hymn-123' }, { slug: 'praise-and-worship' }
    ]);
    assert.equal(reopened.prepare("SELECT count(*) n FROM categories WHERE name = 'Praise'").get().n, 0);
    assert.equal(reopened.prepare('SELECT count(*) n FROM hymn_categories WHERE hymn_id = 8').get().n, 0);
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
