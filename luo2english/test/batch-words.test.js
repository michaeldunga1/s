const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWords } = require('../lib/batch-words');

test('extracts words, lowercases them, and keeps duplicates', () => {
  assert.deepEqual(
    extractWords("  Hello, WORLD!  hello\nbanana;  "),
    ['hello', 'world', 'hello', 'banana']
  );
});

test('removes surrounding punctuation but keeps internal apostrophes and hyphens', () => {
  assert.deepEqual(
    extractWords("(ng'ato) — well-being. [\"test\"] ..."),
    ["ng'ato", 'well-being', 'test']
  );
});

test('returns no words for empty, punctuation-only, or non-string input', () => {
  assert.deepEqual(extractWords('   '), []);
  assert.deepEqual(extractWords('!?,.;:'), []);
  assert.deepEqual(extractWords(null), []);
});
