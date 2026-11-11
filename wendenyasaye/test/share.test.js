const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/share.js'), 'utf8');

function setup(navigator) {
  const link = { href: 'https://example.test/hymns/1', textContent: '' };
  const button = { hidden: true, addEventListener(event, callback) { this.click = callback; } };
  const status = { textContent: '' };
  const elements = { '#share-link': link, '#share-button': button, '#share-status': status };
  const errors = [];
  vm.runInNewContext(script, {
    navigator,
    document: { title: 'Hymn', querySelector: selector => elements[selector] },
    console: { error: (...args) => errors.push(args) }
  });
  return { link, button, status, errors };
}

test('share supports native sharing, clipboard and manual fallback', async () => {
  let shared;
  const native = setup({ share: async data => { shared = data; } });
  await native.button.click();
  assert.equal(shared.url, native.link.href);
  assert.equal(native.status.textContent, 'Share opened.');

  let copied;
  const clipboard = setup({ clipboard: { writeText: async url => { copied = url; } } });
  assert.equal(clipboard.button.textContent, 'Copy link');
  await clipboard.button.click();
  assert.equal(copied, clipboard.link.href);
  assert.equal(clipboard.status.textContent, 'Link copied.');

  const manual = setup({});
  assert.equal(manual.button.hidden, true);
  assert.equal(manual.link.textContent, manual.link.href);
});

test('share reports errors and does not report cancelled sharing as success', async () => {
  const failure = setup({ share: async () => { throw new Error('share failed'); } });
  await failure.button.click();
  assert.match(failure.status.textContent, /Unable to share/);
  assert.equal(failure.errors.length, 1);
  const cancelled = setup({ share: async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; } });
  cancelled.status.textContent = 'Previous success';
  await cancelled.button.click();
  assert.equal(cancelled.status.textContent, '');
  assert.equal(cancelled.errors.length, 0);
});
