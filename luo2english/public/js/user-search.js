const search = document.querySelector('#user-search');
const rows = [...document.querySelectorAll('[data-user-search]')];
search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  let count = 0;
  for (const row of rows) {
    row.hidden = !row.dataset.userSearch.toLocaleLowerCase().includes(query);
    if (!row.hidden) count++;
  }
  document.querySelector('#user-search-status').textContent = query ? `${count} result${count === 1 ? '' : 's'} found.` : '';
});
