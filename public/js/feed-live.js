(() => {
  let latest = null, busy = false, pending = false, revision = 0, dirty = false;
  const main = document.getElementById('workspaceMain');
  function notice() {
    const node = document.getElementById('newJobsNotice');
    if (node) node.hidden = !pending;
  }
  function safeToUpdate() {
    const params = new URLSearchParams(location.search);
    return location.pathname === '/wire' && !document.hidden && !dirty &&
      Number(params.get('page') || 1) === 1 && params.get('sort') !== 'oldest' &&
      window.scrollY < 80 && !document.querySelector('dialog[open], .select-popover') &&
      !main?.contains(document.activeElement) && !main?.hasAttribute('aria-busy');
  }
  async function check() {
    if (document.hidden || location.pathname !== '/wire' || busy) return;
    busy = true;
    const version = revision;
    try {
      const response = await fetch('/wire/version', {headers: {Accept: 'application/json'}, cache: 'no-store'});
      if (!response.ok || response.redirected) return;
      const value = await response.json();
      if (version !== revision || location.pathname !== '/wire') return;
      if (latest !== null && value.latest && latest !== value.latest) pending = true;
      latest = value.latest || '';
      notice();
      if (pending && safeToUpdate() && window.htmx) {
        const source = document.querySelector('#newJobsNotice a');
        await htmx.ajax('GET', location.pathname + location.search, {
          source, target: '#workspaceMain', swap: 'innerHTML'
        });
      }
    } catch (_) { /* Keep current results and retry on the next visible check. */ }
    finally { busy = false; }
  }
  document.addEventListener('input', event => {
    if (event.target.closest('form.toolbar')) dirty = true;
  });
  document.addEventListener('change', event => {
    if (event.target.closest('form.toolbar')) dirty = true;
  });
  document.addEventListener('htmx:beforeRequest', event => {
    if (event.detail.target === main) revision++;
  });
  document.addEventListener('htmx:afterSwap', event => {
    if (event.detail.target !== main) return;
    dirty = false;
    pending = false;
    latest = null;
    notice();
    if (!busy) check();
  });
  document.addEventListener('htmx:historyRestore', () => {
    revision++; latest = null; pending = false; dirty = false; check();
  });
  document.addEventListener('visibilitychange', check);
  setInterval(check, 60000);
  check();
})();
