const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'luo.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE NOT NULL,
    definition TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    value INTEGER NOT NULL CHECK(value IN (-1, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, comment_id),
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const legacyDefinitions = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'definitions'").get();
if (legacyDefinitions) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (db.pragma('foreign_key_check').length) throw new Error('Existing foreign key violations prevent definition migration');
      const hasSequence = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get();
      const oldSequence = hasSequence && db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'comments'").get();
      if (!db.prepare('PRAGMA table_info(words)').all().some(column => column.name === 'definition')) {
        db.exec("ALTER TABLE words ADD COLUMN definition TEXT NOT NULL DEFAULT ''");
      }
      db.exec(`
        UPDATE words SET definition = COALESCE((
          SELECT group_concat(definition, char(10) || char(10))
          FROM (SELECT definition FROM definitions WHERE word_id = words.id ORDER BY id)
        ), '');
        CREATE TABLE comments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          body TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO comments_new (id, word_id, user_id, body, created_at, updated_at)
          SELECT c.id, d.word_id, c.user_id, c.body, c.created_at, c.updated_at
          FROM comments c JOIN definitions d ON d.id = c.definition_id;
        DROP TABLE comments;
        ALTER TABLE comments_new RENAME TO comments;
        DROP TABLE definitions;
      `);
      if (oldSequence) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'comments', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'comments')").run(oldSequence.seq);
        db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'comments'").run(oldSequence.seq);
      }
      if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed during definition migration');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_comments_word_id ON comments(word_id);
  CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_votes_comment_id ON votes(comment_id);
  CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes(user_id);
  CREATE TRIGGER IF NOT EXISTS comments_one_per_word
  BEFORE INSERT ON comments
  WHEN EXISTS (SELECT 1 FROM comments WHERE word_id = NEW.word_id AND user_id = NEW.user_id)
  BEGIN
    SELECT RAISE(ABORT, 'User has already commented on this word');
  END;
`);

module.exports = db;
