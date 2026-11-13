const DEFAULT_PAGE_SIZE = 25;

function parsePage(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

function pageList(currentPage, totalPages, around = 2) {
  if (totalPages <= 1) return [];
  const pages = new Set([1, totalPages]);
  for (let page = currentPage - around; page <= currentPage + around; page += 1) {
    if (page >= 1 && page <= totalPages) pages.add(page);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) result.push(null);
    result.push(page);
  });
  return result;
}

function paginate({ page = 1, pageSize = DEFAULT_PAGE_SIZE, totalItems }) {
  const totalPages = totalItems === 0 ? 1 : Math.ceil(totalItems / pageSize);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  return {
    page: currentPage,
    pageSize,
    totalItems,
    totalPages,
    offset,
    firstItem: totalItems === 0 ? 0 : offset + 1,
    lastItem: Math.min(offset + pageSize, totalItems),
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    pages: pageList(currentPage, totalPages)
  };
}

module.exports = { DEFAULT_PAGE_SIZE, parsePage, paginate, pageList };
