const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('application and admin command require DATABASE_URL', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  for (const [file, args, input] of [
    ['app.js', [], undefined],
    ['scripts/create-admin.js', ['admin@example.com'], 'password123\n']
  ]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', file), ...args], {
      env, input, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DATABASE_URL is required/);
  }
});
