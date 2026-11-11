const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { exportSql } = require('../scripts/export-postgres');

test('PostgreSQL export preserves data, escapes text and supports rollback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wende-pg-export-'));
  const file = path.join(directory, 'test.db');
  try {
    const initialized = spawnSync(process.execPath, ['-e', "require('./db').close()"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_PATH: file },
      encoding: 'utf8'
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)').run(7, 'user', 'user@example.test', 'hash');
    db.prepare('INSERT INTO hymns (id, title, lyrics, slug) VALUES (?, ?, ?, ?)').run(12, "Singer's hymn", "First line\nSecond \\ line", 'singers-hymn');
    db.prepare('INSERT INTO bookmarks (user_id, hymn_id, note, tags) VALUES (?, ?, ?, ?)').run(7, 12, "reader's note", 'one, two');
    db.close();
    const sql = exportSql(file, true);
    assert.match(sql, /INSERT INTO "users".*VALUES \(7, 'user', 'user@example\.test', 'hash', 'user'\);/);
    assert.ok(sql.includes("'Singer''s hymn'"));
    assert.ok(sql.includes("'First line\nSecond \\ line'"));
    assert.ok(sql.includes("'reader''s note'"));
    assert.match(sql, /Destination public schema is not empty/);
    assert.match(sql, /count\(\*\) FROM "bookmarks"\) <> 1/);
    assert.match(sql, /setval\(pg_get_serial_sequence\('hymns'/);
    assert.match(sql, /ROLLBACK;\n$/);
    assert.match(exportSql(file, false), /COMMIT;\n$/);
    const updated = new Database(file);
    updated.exec('CREATE TABLE unexpected_data (value TEXT)');
    updated.close();
    assert.throws(() => exportSql(file, true), /Unknown source tables/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
