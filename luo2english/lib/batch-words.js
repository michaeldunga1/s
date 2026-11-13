const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

function extractWords(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(WORD_PATTERN)]
    .map(match => match[0].normalize('NFC').toLowerCase())
    .filter(Boolean);
}

module.exports = { extractWords };
