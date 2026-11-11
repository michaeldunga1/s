(async () => {
  const list = document.querySelector('#hymn-list');
  const status = document.querySelector('#status');
  const search = document.querySelector('#search');
  const filter = document.querySelector('#favorites-only');
  const categoryFilter = document.querySelector('#category');
  const creditFilter = document.querySelector('#credit-filter');
  try {
    const response = await fetch('/api/hymns');
    if (!response.ok) throw new Error(`Directory request failed (${response.status})`);
    const hymns = await response.json();
    const categories = new Map();
    for (const hymn of hymns) {
      for (const category of hymn.categories || []) categories.set(category.id, category.name);
    }
    for (const [id, name] of [...categories].sort((a, b) => a[1].localeCompare(b[1]))) {
      const option = document.createElement('option');
      option.value = String(id);
      option.textContent = name;
      categoryFilter.append(option);
    }
    let favorites = [];
    try { favorites = JSON.parse(localStorage.getItem('wende-favorites') || '[]'); }
    catch (error) { console.error('Unable to read offline favorites:', error); }
    let selectedCredit = null;
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const matching = hymns.filter(hymn =>
        [hymn.title, hymn.number, hymn.page_number, hymn.author, hymn.composer, hymn.lyrics, ...(hymn.categories || []).map(category => category.name)]
          .some(value => String(value ?? '').toLowerCase().includes(query)) &&
        (!filter.checked || favorites.includes(hymn.id)) &&
        (!categoryFilter.value || (hymn.categories || []).some(category => String(category.id) === categoryFilter.value)) &&
        (!selectedCredit || (selectedCredit.kind === 'author'
          ? (hymn.author || '').toLocaleLowerCase() === selectedCredit.name.toLocaleLowerCase()
          : (hymn.composer || '').split(';').some(name => name.trim().toLocaleLowerCase() === selectedCredit.name.toLocaleLowerCase()))));
      creditFilter.replaceChildren();
      creditFilter.hidden = !selectedCredit;
      if (selectedCredit) {
        const label = document.createElement('span');
        label.textContent = `${selectedCredit.kind === 'author' ? 'Author' : 'Composer'}: ${selectedCredit.name} `;
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'filter-link';
        clear.textContent = 'Clear credit filter';
        clear.addEventListener('click', () => { selectedCredit = null; render(); });
        creditFilter.append(label, clear);
      }
      list.replaceChildren();
      for (const hymn of matching) {
        const card = document.createElement('article');
        card.className = 'hymn';
        const number = document.createElement('div');
        number.className = 'hymn-number';
        number.textContent = hymn.number || '♪';
        const details = document.createElement('div');
        details.className = 'hymn-details';
        const title = document.createElement('h3');
        title.textContent = hymn.title;
        details.append(title);
        if (hymn.author) {
          const author = document.createElement('p');
          author.append('By ');
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'filter-link';
          link.textContent = hymn.author;
          link.addEventListener('click', () => { selectedCredit = { kind: 'author', name: hymn.author }; render(); });
          author.append(link);
          details.append(author);
        }
        if (hymn.composer) {
          const composer = document.createElement('p');
          composer.append('Composer: ');
          hymn.composer.split(';').map(name => name.trim()).filter(Boolean).forEach((name, index) => {
            if (index) composer.append('; ');
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'filter-link';
            link.textContent = name;
            link.addEventListener('click', () => { selectedCredit = { kind: 'composer', name }; render(); });
            composer.append(link);
          });
          details.append(composer);
        }
        if (hymn.page_number) {
          const page = document.createElement('p');
          page.textContent = `Page ${hymn.page_number}`;
          details.append(page);
        }
        if (hymn.categories?.length) {
          const categories = document.createElement('p');
          categories.append('Categories: ');
          hymn.categories.forEach((category, index) => {
            if (index) categories.append(', ');
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'filter-link';
            link.textContent = category.name;
            link.addEventListener('click', () => { categoryFilter.value = String(category.id); render(); });
            categories.append(link);
          });
          details.append(categories);
        }
        const disclosure = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Read hymn';
        const lyrics = document.createElement('div');
        lyrics.className = 'lyrics';
        lyrics.textContent = hymn.lyrics || 'Lyrics have not been added yet. Connect to view the previously saved reference.';
        disclosure.append(summary, lyrics);
        details.append(disclosure);
        card.append(number, details);
        if (favorites.includes(hymn.id)) {
          const star = document.createElement('span');
          star.className = 'favorite is-saved';
          star.setAttribute('aria-label', 'Saved favorite');
          star.textContent = '★';
          card.append(star);
        }
        list.append(card);
      }
      status.textContent = matching.length ? `${matching.length} hymn${matching.length === 1 ? '' : 's'}` : 'No hymns found.';
    };
    search.addEventListener('input', render);
    filter.addEventListener('change', render);
    categoryFilter.addEventListener('change', render);
    render();
  } catch (error) {
    console.error('Unable to load offline directory:', error);
    status.textContent = 'No saved directory is available. Connect to the internet and visit the hymn directory first.';
  }
})();
