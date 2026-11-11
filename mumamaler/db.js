const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { uniqueSlug } = require('./slugs');

const filename = process.env.DB_PATH || path.join(__dirname, 'data', 'mumamaler.db');
fs.mkdirSync(path.dirname(filename), { recursive: true });
const db = new Database(filename);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS readers (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    session_key TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    book_order INTEGER NOT NULL UNIQUE CHECK(book_order > 0),
    testament TEXT CHECK(testament IN ('old', 'new')),
    author_id INTEGER REFERENCES authors(id),
    category_id INTEGER REFERENCES categories(id)
  );
  CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK(number > 0),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE(book_id, number)
  );
  CREATE TABLE IF NOT EXISTS saved_chapters (
    id INTEGER PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    reader_id INTEGER REFERENCES readers(id) ON DELETE CASCADE,
    admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('bookmark', 'favourite')),
    CHECK((reader_id IS NOT NULL AND admin_id IS NULL) OR (reader_id IS NULL AND admin_id IS NOT NULL)),
    UNIQUE(reader_id, chapter_id, kind),
    UNIQUE(admin_id, chapter_id, kind)
  );
`);
db.transaction(() => {
  const readerColumns = db.prepare('PRAGMA table_info(readers)').all().map(column => column.name);
  if (!readerColumns.includes('session_key')) {
    db.exec("ALTER TABLE readers ADD COLUMN session_key TEXT");
    db.exec("UPDATE readers SET session_key = lower(hex(randomblob(32))) WHERE session_key IS NULL");
    db.exec('CREATE UNIQUE INDEX readers_session_key ON readers(session_key)');
  }
  const categoryColumns = db.prepare('PRAGMA table_info(categories)').all().map(column => column.name);
  if (!categoryColumns.includes('description')) db.exec('ALTER TABLE categories ADD COLUMN description TEXT');
  const columns = db.prepare('PRAGMA table_info(books)').all().map(column => column.name);
  if (!columns.includes('testament')) db.exec("ALTER TABLE books ADD COLUMN testament TEXT CHECK(testament IN ('old', 'new'))");
  if (!columns.includes('author_id')) db.exec('ALTER TABLE books ADD COLUMN author_id INTEGER REFERENCES authors(id)');
  if (!columns.includes('category_id')) db.exec('ALTER TABLE books ADD COLUMN category_id INTEGER REFERENCES categories(id)');
  const savedColumns = db.prepare('PRAGMA table_info(saved_chapters)').all().map(column => column.name);
  if (!savedColumns.includes('note')) db.exec("ALTER TABLE saved_chapters ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  if (!savedColumns.includes('tags')) db.exec("ALTER TABLE saved_chapters ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  db.exec(`
    DELETE FROM saved_chapters AS f WHERE f.kind = 'favourite' AND EXISTS (
      SELECT 1 FROM saved_chapters AS b
      WHERE b.kind = 'bookmark' AND b.chapter_id = f.chapter_id
      AND ((f.reader_id IS NOT NULL AND b.reader_id = f.reader_id)
        OR (f.admin_id IS NOT NULL AND b.admin_id = f.admin_id))
    );
    UPDATE saved_chapters SET kind = 'bookmark' WHERE kind = 'favourite';
  `);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'verses'").get()) {
    if (db.pragma('foreign_key_check').length) throw new Error('Existing foreign key violations prevent chapter migration');
    db.exec(`
      INSERT INTO chapters (book_id, number, title, body)
      SELECT book_id, chapter, '', group_concat(verse || ' ' || text, char(10))
      FROM (SELECT book_id, chapter, verse, text FROM verses ORDER BY book_id, chapter, verse)
      GROUP BY book_id, chapter;
      DROP TABLE verses;
    `);
  }
  for (const [table, label, fallback] of [
    ['books', 'name', 'book'], ['authors', 'name', 'author'],
    ['categories', 'name', 'category'], ['chapters', 'title', 'chapter']
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'slug')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN slug TEXT`);
    }
    const records = db.prepare(`SELECT * FROM ${table} WHERE slug IS NULL OR slug = '' ORDER BY id`).all();
    const update = db.prepare(`UPDATE ${table} SET slug = ? WHERE id = ?`);
    for (const row of records) {
      const base = table === 'chapters' ? row[label] || `chapter-${row.number}` : row[label];
      update.run(uniqueSlug(db, table, base, table === 'chapters' ? `chapter-${row.number}` : fallback, row.book_id), row.id);
    }
    db.exec(table === 'chapters'
      ? 'CREATE UNIQUE INDEX IF NOT EXISTS chapters_slug_unique ON chapters(book_id, slug)'
      : `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_slug_unique ON ${table}(slug)`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_slug_required_insert
      BEFORE INSERT ON ${table} WHEN NEW.slug IS NULL OR NEW.slug = ''
      BEGIN SELECT RAISE(ABORT, 'A slug is required'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_slug_required_update
      BEFORE UPDATE OF slug ON ${table} WHEN NEW.slug IS NULL OR NEW.slug = ''
      BEGIN SELECT RAISE(ABORT, 'A slug is required'); END;
    `);
  }
})();
module.exports = db;
