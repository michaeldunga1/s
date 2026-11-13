function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const entries = new Map();

  function cleanup(now) {
    if (entries.size <= 1000) return;
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  function status(key, now = Date.now()) {
    const entry = entries.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  function consume(key, now = Date.now()) {
    cleanup(now);
    const entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return { blocked: false, retryAfter: 0 };
    }
    if (entry.count >= max) {
      return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count += 1;
    return { blocked: false, retryAfter: 0 };
  }

  function reset(key) {
    entries.delete(key);
  }

  return { status, consume, reset };
}

module.exports = { createRateLimiter };
