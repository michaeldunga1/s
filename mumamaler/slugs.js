function slugBase(value, fallback) {
  const slug = value.normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019\u02bc']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return fallback;
  return /^\d+$/.test(slug) ? `${fallback}-${slug}` : slug;
}

function uniqueSlug(db, table, value, fallback, bookId = null, excludeId = null) {
  const base = slugBase(value, fallback);
  const exists = table === 'chapters'
    ? db.prepare('SELECT 1 FROM chapters WHERE book_id = ? AND slug = ? AND id != ?')
    : db.prepare(`SELECT 1 FROM ${table} WHERE slug = ? AND id != ?`);
  let slug = base;
  let suffix = 2;
  while (table === 'chapters' ? exists.get(bookId, slug, excludeId || 0) : exists.get(slug, excludeId || 0)) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

module.exports = { slugBase, uniqueSlug };
