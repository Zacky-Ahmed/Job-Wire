(function () {
  const dialog = document.getElementById('commandDialog');
  const open = document.getElementById('commandOpen');
  open.hidden = false;
  open.addEventListener('click', () => dialog.showModal());
  document.getElementById('commandClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog && (e.clientX < dialog.getBoundingClientRect().left || e.clientX > dialog.getBoundingClientRect().right || e.clientY < dialog.getBoundingClientRect().top || e.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); dialog.open ? dialog.close() : dialog.showModal();
    }
  });
  const rows = document.getElementById('wireRows');
  const panel = rows ? rows.closest('.panel') : document.querySelector('.wrap .panel');
  if (!panel) return;
  const tools = document.createElement('div');
  tools.className = 'feed-tools';
  tools.innerHTML = '<label class="feed-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Filter loaded rows" placeholder="Search this page…"></label><span class="feed-count" aria-live="polite"></span><button class="btn btn-xs" type="button" aria-pressed="false">Compact view</button>';
  panel.querySelector('.panel-h').after(tools);
  const input = tools.querySelector('input');
  const count = tools.querySelector('.feed-count');
  const compact = tools.querySelector('button');
  const empty = document.createElement('p');
  empty.className = 'filter-empty'; empty.hidden = true;
  empty.textContent = 'No matches on this page. Try another search.';
  panel.append(empty);
  let index = [];
  function collect() {
    index = Array.from(document.querySelectorAll('.wrap .row:not(.rhead)')).map(el => ({el, text:el.textContent.toLowerCase()}));
    filter();
  }
  function filter() {
    const term = input.value.trim().toLowerCase();
    let shown = 0;
    index.forEach(({el,text}) => { el.hidden = !text.includes(term); if (!el.hidden) shown++; });
    count.textContent = shown + ' of ' + index.length + ' loaded';
    empty.hidden = !term || shown > 0;
  }
  function density(on) {
    document.body.classList.toggle('compact', on);
    compact.setAttribute('aria-pressed', String(on));
    compact.textContent = on ? 'Comfortable view' : 'Compact view';
  }
  try { density(localStorage.getItem('jw.compact') === '1'); } catch (_) {}
  compact.addEventListener('click', () => {
    const on = !document.body.classList.contains('compact'); density(on);
    try { localStorage.setItem('jw.compact', on ? '1' : '0'); } catch (_) {}
  });
  input.addEventListener('input', filter);
  document.body.addEventListener('htmx:afterSwap', collect);
  collect();
  // Avoid replacing a focused link, and skip background requests in hidden tabs.
  document.body.addEventListener('htmx:beforeRequest', e => {
    if (e.detail.elt === rows && (document.hidden || rows.contains(document.activeElement))) e.preventDefault();
  });
  let lastResponse = null;
  document.body.addEventListener('htmx:beforeSwap', e => {
    if (e.detail.target !== rows || e.detail.xhr.status !== 200) return;
    const response = e.detail.xhr.responseText;
    if (response === lastResponse) e.detail.shouldSwap = false;
    lastResponse = response;
  });
})();
