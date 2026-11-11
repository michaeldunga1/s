const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { uniqueHymnSlug } = require('./slugs');
const { suggestions } = require('./categories');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'wendenyasaye.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
  );
  CREATE TABLE IF NOT EXISTS hymns (
    id INTEGER PRIMARY KEY,
    number INTEGER UNIQUE CHECK (number > 0),
    title TEXT NOT NULL,
    lyrics TEXT NOT NULL,
    author_id INTEGER REFERENCES authors(id),
    legacy_url TEXT
  );
  CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hymn_id INTEGER NOT NULL REFERENCES hymns(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, hymn_id)
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hymn_id INTEGER NOT NULL REFERENCES hymns(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, hymn_id)
  );
`);

const bookmarkColumns = db.prepare('PRAGMA table_info(bookmarks)').all().map(column => column.name);
if (!bookmarkColumns.includes('note')) db.exec("ALTER TABLE bookmarks ADD COLUMN note TEXT NOT NULL DEFAULT ''");
if (!bookmarkColumns.includes('tags')) db.exec("ALTER TABLE bookmarks ADD COLUMN tags TEXT NOT NULL DEFAULT ''");

if (db.prepare('PRAGMA table_info(hymns)').all().some(column => column.name === 'url')) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE hymns_new (
          id INTEGER PRIMARY KEY,
          number INTEGER UNIQUE CHECK (number > 0),
          title TEXT NOT NULL,
          lyrics TEXT NOT NULL,
          author_id INTEGER REFERENCES authors(id),
          legacy_url TEXT
        );
        INSERT INTO hymns_new (id, number, title, lyrics, legacy_url)
          SELECT id, number, title, '', url FROM hymns;
        DROP TABLE hymns;
        ALTER TABLE hymns_new RENAME TO hymns;
      `);
      if (db.pragma('foreign_key_check').length) throw new Error('Hymn migration would break foreign keys');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)');

const hymnColumns = db.prepare('PRAGMA table_info(hymns)').all().map(column => column.name);
if (!hymnColumns.includes('composer')) db.exec("ALTER TABLE hymns ADD COLUMN composer TEXT NOT NULL DEFAULT ''");
if (!hymnColumns.includes('page_number')) db.exec('ALTER TABLE hymns ADD COLUMN page_number INTEGER CHECK (page_number IS NULL OR page_number > 0)');

db.transaction(() => {
  if (!db.prepare('PRAGMA table_info(hymns)').all().some(column => column.name === 'slug')) {
    db.exec('ALTER TABLE hymns ADD COLUMN slug TEXT');
  }
  const update = db.prepare('UPDATE hymns SET slug = ? WHERE id = ?');
  for (const hymn of db.prepare("SELECT id, title FROM hymns WHERE slug IS NULL OR slug = '' ORDER BY id").all()) {
    update.run(uniqueHymnSlug(db, hymn.title), hymn.id);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS hymns_slug_unique ON hymns(slug);
    CREATE TRIGGER IF NOT EXISTS hymns_slug_required_insert
    BEFORE INSERT ON hymns WHEN NEW.slug IS NULL OR NEW.slug = '' OR NEW.slug NOT GLOB '*[^0-9]*'
    BEGIN SELECT RAISE(ABORT, 'A non-numeric slug is required'); END;
    CREATE TRIGGER IF NOT EXISTS hymns_slug_required_update
    BEFORE UPDATE OF slug ON hymns WHEN NEW.slug IS NULL OR NEW.slug = '' OR NEW.slug NOT GLOB '*[^0-9]*'
    BEGIN SELECT RAISE(ABORT, 'A non-numeric slug is required'); END;
  `);
})();

db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    );
    CREATE TABLE IF NOT EXISTS hymn_categories (
      hymn_id INTEGER NOT NULL REFERENCES hymns(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      PRIMARY KEY (hymn_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY);
  `);
  const migration = 'initial-hymn-categories-v1';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(migration)) {
    const insertCategory = db.prepare('INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
    const findCategory = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE');
    const insertLink = db.prepare('INSERT INTO hymn_categories (hymn_id, category_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
    for (const [name, pattern] of suggestions) {
      insertCategory.run(name);
      const id = findCategory.get(name).id;
      for (const hymn of db.prepare('SELECT id, title FROM hymns').all()) {
        if (pattern.test(hymn.title)) insertLink.run(hymn.id, id);
      }
    }
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(migration);
  }
})();

module.exports = db;
