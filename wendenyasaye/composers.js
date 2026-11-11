function composerNames(credit) {
  const seen = new Set();
  return (credit || '').split(';').map(name => name.trim()).filter(name => {
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { composerNames };
