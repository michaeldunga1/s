const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, paginate, pageList } = require('../lib/pagination');

test('parsePage accepts positive integers and defaults invalid values to page 1', () => {
  assert.equal(parsePage('3'), 3);
  assert.equal(parsePage(2), 2);
  assert.equal(parsePage('0'), 1);
  assert.equal(parsePage('-4'), 1);
  assert.equal(parsePage('abc'), 1);
  assert.equal(parsePage('1.5'), 1);
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage(['2']), 1);
  assert.equal(parsePage('999999999999999999999'), 1);
});

test('paginate reports bounds and clamps out-of-range pages', () => {
  const middle = paginate({ page: 2, pageSize: 10, totalItems: 35 });
  assert.equal(middle.page, 2);
  assert.equal(middle.totalPages, 4);
  assert.equal(middle.offset, 10);
  assert.equal(middle.firstItem, 11);
  assert.equal(middle.lastItem, 20);
  assert.equal(middle.hasPrev, true);
  assert.equal(middle.hasNext, true);

  const clamped = paginate({ page: 99, pageSize: 10, totalItems: 35 });
  assert.equal(clamped.page, 4);
  assert.equal(clamped.firstItem, 31);
  assert.equal(clamped.lastItem, 35);
  assert.equal(clamped.hasNext, false);

  const empty = paginate({ page: 1, pageSize: 10, totalItems: 0 });
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.firstItem, 0);
  assert.equal(empty.lastItem, 0);
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
});

test('pageList collapses distant pages with ellipsis markers', () => {
  assert.deepEqual(pageList(1, 1), []);
  assert.deepEqual(pageList(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageList(5, 10), [1, null, 3, 4, 5, 6, 7, null, 10]);
});
