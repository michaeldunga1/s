function hymnSlugBase(title) {
  let base = title.normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019\u02bc']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'hymn';
  if (/^\d+$/.test(base)) base = `hymn-${base}`;
  return base;
}

function uniqueHymnSlug(db, title) {
  const base = hymnSlugBase(title);
  const exists = db.prepare('SELECT 1 FROM hymns WHERE slug = ?');
  let slug = base;
  let suffix = 2;
  while (exists.get(slug)) slug = `${base}-${suffix++}`;
  return slug;
}

module.exports = { hymnSlugBase, uniqueHymnSlug };
