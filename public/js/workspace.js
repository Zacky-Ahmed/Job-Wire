// workspace.js
//
// Two jobs, and keeping them apart is the whole point of this file.
//
// SHELL wiring runs exactly once, for the life of the tab: the sidebar
// toggle, the command dialog, the Ctrl-K shortcut. Those elements live
// outside <main> and survive every navigation.
//
// MOUNT wiring runs once per page, on load and again after every swap
// of #workspaceMain, because that content is thrown away and replaced.
// Before the shell persisted, a full page load reset everything and this
// distinction did not exist; now, anything that binds to something inside
// <main> and is not re-run is silently dead after the first tab change,
// and anything bound to `document` and re-run is a duplicate handler that
// accumulates for as long as the tab is open.
(function () {
  var main = document.getElementById('workspaceMain');

  /* ---- shell: once ---- */

  /* Sidebar collapse.
   *
   * The SERVER already rendered the collapsed class from the jw.sidebar
   * cookie, exactly as it does the theme, so there is nothing to apply on
   * load and no flash. This only flips it and writes the cookie back —
   * localStorage would be invisible to the server and the page would jump
   * 140px sideways on every navigation. */
  var sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle) {
    var root = document.documentElement;
    var describe = function () {
      var collapsed = root.classList.contains('sidebar-collapsed');
      sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
      var what = collapsed ? 'Expand sidebar' : 'Minimize sidebar';
      sidebarToggle.setAttribute('aria-label', what);
      sidebarToggle.title = what;
    };
    // Revealed only now: a control that does nothing without script has
    // no business being offered to a browser that will not run it.
    sidebarToggle.hidden = false;
    describe();
    sidebarToggle.addEventListener('click', function () {
      var collapsed = root.classList.toggle('sidebar-collapsed');
      describe();
      document.cookie = 'jw.sidebar=' + (collapsed ? '1' : '0') +
        ';path=/;max-age=31536000;samesite=lax' +
        (location.protocol === 'https:' ? ';secure' : '');
    });
  }

  var dialog = document.getElementById('commandDialog');
  if (dialog) {
    var closeBtn = document.getElementById('commandClose');
    if (closeBtn) closeBtn.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) {
      if (e.target !== dialog) return;
      var b = dialog.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right ||
          e.clientY < b.top || e.clientY > b.bottom) dialog.close();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (dialog.open) dialog.close(); else dialog.showModal();
      }
    });
    /* Delegated, because #commandOpen sits in the heading — inside the
       swapped region — so the button that exists now is not the button
       that will exist after the next tab change. Binding to the instance
       would work exactly once. */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('#commandOpen')) dialog.showModal();
    });
    // Navigating from inside the palette should not leave it hanging open.
    dialog.addEventListener('htmx:beforeRequest', function () { dialog.close(); });
  }

  /* ---- mount: once per page ---- */

  var index = [];    // the rows currently filterable
  var input = null;  // the live filter box, or null on pages without rows
  var count = null;
  var emptyNote = null;

  function readCompact() {
    try { return localStorage.getItem('jw.compact') === '1'; } catch (_) { return false; }
  }

  function filter() {
    if (!input) return;
    var term = input.value.trim().toLowerCase();
    var shown = 0;
    index.forEach(function (e) {
      e.el.hidden = e.text.indexOf(term) === -1;
      if (!e.el.hidden) shown++;
    });
    count.textContent = shown + ' of ' + index.length + ' loaded';
    emptyNote.hidden = !term || shown > 0;
  }

  function collect() {
    index = Array.prototype.map.call(
      document.querySelectorAll('.wrap .row:not(.rhead)'),
      function (el) { return { el: el, text: el.textContent.toLowerCase() }; });
    filter();
  }

  function density(on, button) {
    document.body.classList.toggle('compact', on);
    if (!button) return;
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Comfortable view' : 'Compact view';
  }

  function mount() {
    var open = document.getElementById('commandOpen');
    if (open && dialog) open.hidden = false;

    input = null; count = null; emptyNote = null;
    index = [];

    var rows = document.getElementById('wireRows');
    var panel = rows ? rows.closest('.panel') : document.querySelector('.wrap .panel');
    var head = panel ? panel.querySelector('.panel-h') : null;
    if (!panel || !head) return;

    /* Reuse the toolbar if this page already has one.

       It is built by script rather than rendered, so a mount that always
       created it would stack a second search box under the first on every
       return to the same tab. Idempotence is not optional here — this
       function runs once per navigation, for as long as the tab is open. */
    var tools = panel.querySelector('.feed-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'feed-tools';
      tools.innerHTML =
        '<label class="feed-search"><span aria-hidden="true">⌕</span>' +
        '<input type="search" aria-label="Filter loaded rows" placeholder="Search this page…"></label>' +
        '<span class="feed-count" aria-live="polite"></span>' +
        '<button class="btn btn-xs" type="button" aria-pressed="false">Compact view</button>';
      head.after(tools);
      var compact = tools.querySelector('button');
      density(readCompact(), compact);
      compact.addEventListener('click', function () {
        var on = !document.body.classList.contains('compact');
        density(on, compact);
        try { localStorage.setItem('jw.compact', on ? '1' : '0'); } catch (_) {}
      });
      tools.querySelector('input').addEventListener('input', filter);
    } else {
      density(readCompact(), tools.querySelector('button'));
    }

    input = tools.querySelector('input');
    count = tools.querySelector('.feed-count');

    emptyNote = panel.querySelector('.filter-empty');
    if (!emptyNote) {
      emptyNote = document.createElement('p');
      emptyNote.className = 'filter-empty';
      emptyNote.textContent = 'No matches on this page. Try another search.';
      panel.append(emptyNote);
    }
    emptyNote.hidden = true;

    collect();
  }

  /* ---- swaps ---- */

  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (main && e.detail.target === main) {
      mount();
      /* Send the reader to the top of the new page. A swap moves no
         focus on its own, so a keyboard or screen-reader user would be
         left inside content that no longer exists. */
      main.focus({ preventScroll: true });
      return;
    }
    // Anything smaller — the 15s wire poll, a row-level update — only
    // changes what is filterable.
    collect();
  });

  // Avoid replacing a focused link, and skip background requests in hidden tabs.
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    var rows = document.getElementById('wireRows');
    if (rows && e.detail.elt === rows &&
        (document.hidden || rows.contains(document.activeElement))) {
      e.preventDefault();
    }
  });

  var lastResponse = null;
  document.body.addEventListener('htmx:beforeSwap', function (e) {
    var rows = document.getElementById('wireRows');
    if (!rows || e.detail.target !== rows || e.detail.xhr.status !== 200) return;
    var response = e.detail.xhr.responseText;
    if (response === lastResponse) e.detail.shouldSwap = false;
    lastResponse = response;
  });

  mount();
})();
