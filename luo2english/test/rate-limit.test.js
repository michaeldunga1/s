const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../lib/rate-limit');

test('rate limiter blocks after the configured maximum and reports retry time', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
  assert.deepEqual(limiter.consume('key', 0), { blocked: false, retryAfter: 0 });
  assert.deepEqual(limiter.consume('key', 10), { blocked: false, retryAfter: 0 });
  assert.equal(limiter.status('key', 20), 1);
  assert.deepEqual(limiter.consume('key', 20), { blocked: true, retryAfter: 1 });
});

test('rate limiter resets after the window and supports manual reset', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
  assert.equal(limiter.consume('key', 0).blocked, false);
  assert.equal(limiter.status('key', 500), 1);
  assert.equal(limiter.status('key', 1000), 0);
  assert.equal(limiter.consume('key', 1000).blocked, false);
  limiter.reset('key');
  assert.equal(limiter.status('key', 1001), 0);
});

test('rate limiter keys are isolated from one another', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
  assert.equal(limiter.consume('first', 0).blocked, false);
  assert.equal(limiter.consume('second', 0).blocked, false);
  assert.equal(limiter.status('first', 10), 1);
  assert.equal(limiter.status('second', 10), 1);
});
