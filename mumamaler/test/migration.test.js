const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('legacy verses become ordered chapter bodies without guessing metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muma-migrate-'));
  const file = path.join(dir, 'legacy.db');
  try {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, book_order INTEGER UNIQUE NOT NULL);
      CREATE TABLE verses (id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id), chapter INTEGER NOT NULL, verse INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE(book_id, chapter, verse));
      CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      INSERT INTO categories VALUES (7, 'Existing category');
      INSERT INTO books VALUES (1, 'Example', 1);
      INSERT INTO verses VALUES (1, 1, 1, 2, 'Second'), (2, 1, 1, 1, 'First'), (3, 1, 2, 1, 'Next chapter');
    `);
    db.close();
    const result = spawnSync(process.execPath, ['-e', "const db=require('./db'); console.log(JSON.stringify({books:db.prepare('select * from books').all(),categories:db.prepare('select * from categories').all(),chapters:db.prepare('select * from chapters order by number').all(),issues:db.pragma('foreign_key_check')}))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.books[0].testament, null);
    assert.deepEqual(data.categories, [{ id: 7, name: 'Existing category', description: null, slug: 'existing-category' }]);
    assert.equal(data.chapters[0].body, '1 First\n2 Second');
    assert.equal(data.chapters[0].title, '');
    assert.equal(data.books[0].slug, 'example');
    assert.equal(data.chapters[0].slug, 'chapter-1');
    assert.equal(data.chapters[1].slug, 'chapter-2');
    assert.equal(data.chapters[1].body, '1 Next chapter');
    assert.deepEqual(data.issues, []);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('favourites migrate to bookmarks without duplicates and migration is repeatable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muma-bookmarks-'));
  const file = path.join(dir, 'legacy.db');
  const runMigration = () => spawnSync(process.execPath, ['-e', "const db=require('./db'); db.close()"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file }, encoding: 'utf8'
  });
  try {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE admins (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
      CREATE TABLE readers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
      CREATE TABLE books (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, book_order INTEGER UNIQUE NOT NULL);
      CREATE TABLE chapters (id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id), number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(book_id, number));
      CREATE TABLE saved_chapters (
        id INTEGER PRIMARY KEY, chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        reader_id INTEGER REFERENCES readers(id), admin_id INTEGER REFERENCES admins(id),
        kind TEXT NOT NULL CHECK(kind IN ('bookmark', 'favourite')),
        UNIQUE(reader_id, chapter_id, kind), UNIQUE(admin_id, chapter_id, kind)
      );
      INSERT INTO readers VALUES (1, 'reader@example.com', 'hash'), (2, 'other@example.com', 'hash');
      INSERT INTO admins VALUES (1, 'admin@example.com', 'hash');
      INSERT INTO books VALUES (1, 'Test', 1);
      INSERT INTO chapters VALUES (1, 1, 1, '', 'body'), (2, 1, 2, '', 'body');
      INSERT INTO saved_chapters VALUES (1, 1, 1, NULL, 'bookmark'), (2, 1, 1, NULL, 'favourite'),
        (3, 2, 1, NULL, 'favourite'), (4, 1, 2, NULL, 'favourite'),
        (5, 1, NULL, 1, 'favourite');
    `);
    db.close();
    let result = runMigration();
    assert.equal(result.status, 0, result.stderr);
    const migrated = new Database(file);
    assert.deepEqual(migrated.prepare('SELECT slug FROM chapters ORDER BY number').all(), [{ slug: 'chapter-1' }, { slug: 'chapter-2' }]);
    const readerKeys = migrated.prepare('SELECT session_key FROM readers ORDER BY id').all();
    assert.equal(readerKeys.length, 2);
    assert.ok(readerKeys.every(row => /^[0-9a-f]{64}$/.test(row.session_key)));
    assert.notEqual(readerKeys[0].session_key, readerKeys[1].session_key);
    assert.deepEqual(migrated.prepare('SELECT id, chapter_id, reader_id, admin_id, kind, note, tags FROM saved_chapters ORDER BY id').all(), [
      { id: 1, chapter_id: 1, reader_id: 1, admin_id: null, kind: 'bookmark', note: '', tags: '' },
      { id: 3, chapter_id: 2, reader_id: 1, admin_id: null, kind: 'bookmark', note: '', tags: '' },
      { id: 4, chapter_id: 1, reader_id: 2, admin_id: null, kind: 'bookmark', note: '', tags: '' },
      { id: 5, chapter_id: 1, reader_id: null, admin_id: 1, kind: 'bookmark', note: '', tags: '' }
    ]);
    migrated.prepare("UPDATE saved_chapters SET note = 'keep this', tags = 'hope' WHERE id = 1").run();
    migrated.close();
    result = runMigration();
    assert.equal(result.status, 0, result.stderr);
    const again = new Database(file);
    assert.deepEqual(again.prepare('SELECT slug FROM chapters ORDER BY number').all(), [{ slug: 'chapter-1' }, { slug: 'chapter-2' }]);
    assert.deepEqual(again.prepare('SELECT session_key FROM readers ORDER BY id').all(), readerKeys);
    assert.deepEqual(again.prepare('SELECT note, tags FROM saved_chapters WHERE id = 1').get(), { note: 'keep this', tags: 'hope' });
    assert.equal(again.prepare('SELECT count(*) n FROM saved_chapters').get().n, 4);
    assert.deepEqual(again.pragma('foreign_key_check'), []);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true }); }
});
