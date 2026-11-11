(() => {
  const favorites = document.querySelector('#favorite-data');
  if (favorites) {
    try { localStorage.setItem('wende-favorites', favorites.dataset.favorites); }
    catch (error) { console.error('Unable to save offline favorites:', error); }
  }
  const clearFavorites = () => {
    try { localStorage.removeItem('wende-favorites'); }
    catch (error) { console.error('Unable to clear offline favorites:', error); }
  };
  if (new URLSearchParams(location.search).has('signed_out')) clearFavorites();
  document.querySelector('#logout-form')?.addEventListener('submit', clearFavorites);

  const search = document.querySelector('#search');
  const filter = document.querySelector('#favorites-only');
  const cards = [...document.querySelectorAll('#hymn-list .hymn')];
  const update = () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const match = card.dataset.search.toLowerCase().includes(query) &&
        (!filter?.checked || card.dataset.favorite === 'true');
      card.hidden = !match;
      if (match) visible++;
    }
    document.querySelector('#empty').hidden = visible !== 0;
  };
  search?.addEventListener('input', update);
  filter?.addEventListener('change', update);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => fetch('/api/hymns'))
      .then(response => {
        if (!response.ok) throw new Error(`Directory refresh failed (${response.status})`);
      })
      .catch(error => console.error('Offline setup or directory refresh failed:', error));
  }
})();
