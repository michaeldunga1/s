const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportSql } = require('./export');

for (const app of ['luo2english', 'mumamaler']) {
  test(`${app} export preserves escaped data and refuses unexpected tables`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${app}-pg-`));
    const filename = path.join(dir, 'source.db');
    const appDir = path.resolve(__dirname, '..', app);
    try {
      const initialization = spawnSync(process.execPath, ['-e', `require('${app === 'luo2english' ? './db/init' : './db'}').close()`], {
        cwd: appDir, env: { ...process.env, DB_PATH: filename }, encoding: 'utf8'
      });
      assert.equal(initialization.status, 0, initialization.stderr);
      const Database = createRequire(path.join(appDir, 'package.json'))('better-sqlite3');
      const db = new Database(filename);
      if (app === 'luo2english') {
        db.prepare('INSERT INTO words (id, word, definition) VALUES (?, ?, ?)').run(80, "test's word", 'line one\nline \\ two');
        db.prepare('DELETE FROM words WHERE id = ?').run(80);
        db.prepare('INSERT INTO words (id, word, definition) VALUES (?, ?, ?)').run(10, "test's word", 'line one\nline \\ two');
      } else {
        db.prepare('INSERT INTO authors (id, name, slug) VALUES (?, ?, ?)').run(10, "test's author", 'test-author');
      }
      db.close();
      const sql = exportSql(app, filename, true);
      assert.ok(sql.includes(app === 'luo2english' ? "'test''s word'" : "'test''s author'"));
      assert.match(sql, /Row count mismatch/);
      assert.match(sql, /Destination public schema is not empty/);
      assert.match(sql, /ROLLBACK;\n$/);
      assert.match(exportSql(app, filename, false), /COMMIT;\n$/);
      if (app === 'luo2english') {
        assert.ok(sql.includes("'line one\nline \\ two'"));
        assert.match(sql, /SELECT MAX\(id\) FROM "words"\), 0\), 80, 1\)/);
      }
      const updated = new Database(filename);
      updated.exec('CREATE TABLE unexpected_data (value TEXT)');
      updated.close();
      assert.throws(() => exportSql(app, filename, true), /Unknown source tables/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
}

test('invalid input fails explicitly', () => {
  assert.throws(() => exportSql('unknown', 'missing.db', true), /Unknown application/);
});
