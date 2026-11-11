for (const search of document.querySelectorAll('[data-list-search]')) {
  const list = search.nextElementSibling;
  if (!list || !list.matches('[data-search-list]')) continue;
  const input = search.querySelector('input');
  const status = search.querySelector('[role="status"]');
  const items = [...list.querySelectorAll('[data-search-item]')];
  const filter = () => {
    const query = input.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const item of items) {
      const match = item.dataset.searchText.toLocaleLowerCase().includes(query);
      item.hidden = !match;
      if (match) count++;
    }
    status.textContent = query ? (count ? `${count} result${count === 1 ? '' : 's'} found.` : 'No results found.') : '';
  };
  input.addEventListener('input', filter);
  search.hidden = false;
  filter();
}
