const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/offline.js'), 'utf8');

test('service worker includes the local icon sprite for offline use', () => {
  const serviceWorker = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(serviceWorker, /['"]\/icons\.svg['"]/);
  assert.ok(fs.existsSync(path.join(__dirname, '../public/icons.svg')));
});

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute() {}
}

test('offline directory filters cached categories and favorites together', async () => {
  const elements = Object.fromEntries(['hymn-list', 'status', 'search', 'favorites-only', 'category', 'credit-filter'].map(id => [id, new Element()]));
  const hymns = [
    { id: 1, title: 'Praise hymn', lyrics: 'Unique verse', composer: 'Composer', categories: [{ id: 1, name: 'Praise' }, { id: 2, name: 'Worship' }] },
    { id: 2, title: 'Other hymn', categories: [{ id: 2, name: 'Worship' }] },
    { id: 3, title: 'Old cached hymn' }
  ];
  await vm.runInNewContext(script, {
    document: { querySelector: selector => elements[selector.slice(1)], createElement: () => new Element() },
    fetch: async () => ({ ok: true, json: async () => hymns }),
    localStorage: { getItem: () => '[1]' },
    console
  });
  assert.equal(elements['hymn-list'].children.length, 3);
  assert.equal(elements.category.children.length, 2);
  elements.category.value = '2';
  elements.category.listeners.change();
  assert.equal(elements['hymn-list'].children.length, 2);
  elements['favorites-only'].checked = true;
  elements['favorites-only'].listeners.change();
  assert.equal(elements['hymn-list'].children.length, 1);
  elements.search.value = 'unique verse';
  elements.search.listeners.input();
  assert.equal(elements['hymn-list'].children.length, 1);
  elements.search.value = 'composer';
  elements.search.listeners.input();
  assert.equal(elements['hymn-list'].children.length, 1);
  elements.search.value = 'other';
  elements.search.listeners.input();
  assert.equal(elements['hymn-list'].children.length, 0);
  assert.equal(elements.status.textContent, 'No hymns found.');
  elements.search.value = '';
  elements['favorites-only'].checked = false;
  elements.category.value = '';
  elements.search.listeners.input();
  const firstDetails = elements['hymn-list'].children[0].children[1];
  const composer = firstDetails.children.find(child => child instanceof Element && child.children.some(part => part instanceof Element && part.textContent === 'Composer'));
  composer.children.find(part => part instanceof Element && part.textContent === 'Composer').listeners.click();
  assert.equal(elements['hymn-list'].children.length, 1);
  assert.equal(elements['credit-filter'].hidden, false);
  elements['credit-filter'].children[1].listeners.click();
  assert.equal(elements['hymn-list'].children.length, 3);
  const categories = elements['hymn-list'].children[0].children[1].children.find(child => child instanceof Element && child.children.some(part => part instanceof Element && part.textContent === 'Worship'));
  categories.children.find(part => part instanceof Element && part.textContent === 'Worship').listeners.click();
  assert.equal(elements.category.value, '2');
  assert.equal(elements['hymn-list'].children.length, 2);
});
