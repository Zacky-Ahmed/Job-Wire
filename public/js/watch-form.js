// watch-form.js — the two live bits of the new-watch form.
//
// These used to be two <script src> tags at the bottom of watches.ejs.
// That was fine while every navigation was a full page load: the scripts
// arrived with the page, ran once, and died with it. Now the shell
// persists and only <main> is replaced, so a script tag inside the page
// is re-inserted and re-evaluated on every visit to Watches — two extra
// requests per navigation for files the browser already has, and a
// second copy of logic that the shell could simply hold.
//
// So they live in the shell now, loaded once, and re-run themselves when
// the form arrives. Everything below binds only to elements inside the
// swapped region and re-reads them on every mount; nothing is captured
// across a navigation, which is the same rule workspace.js and ticker.js
// follow.
(function () {
  var main = document.getElementById('workspaceMain');

  /** Live label for the interval slider. */
  function slider() {
    var input = document.getElementById('every');
    var out = document.getElementById('everyOut');
    if (!input || !out) return;
    function paint() {
      var n = Number(input.value);
      out.textContent = n + (n === 1 ? ' minute' : ' minutes');
    }
    input.addEventListener('input', paint);
    paint();
  }

  /* Says which sites this watch will cover. It used to be a row of
     checkboxes, which asked the reader to make a decision they had no
     basis for — nobody wants fewer places searched for the same keyword,
     and picking a Sri Lankan board for a German watch just built
     something that could never match.

     The country decides, so this only reports. The server derives the
     same list independently; nothing here is submitted. */
  function sources() {
    var geo = document.getElementById('geo');
    var out = document.getElementById('srcList');
    if (!geo || !out) return;

    var all = [];
    try { all = JSON.parse(out.dataset.sources || '[]'); } catch (e) { return; }

    function render() {
      var country = geo.value;
      var live = all.filter(function (s) {
        return !s.countries || !s.countries.length || s.countries.indexOf(country) !== -1;
      });
      out.innerHTML = '';
      live.forEach(function (s) {
        var row = document.createElement('span');
        row.className = 'srcs-chip';
        var n = document.createElement('b');
        n.textContent = s.label;
        row.appendChild(n);
        if (s.note) {
          var h = document.createElement('i');
          h.textContent = s.note;
          row.appendChild(h);
        }
        out.appendChild(row);
      });
    }

    geo.addEventListener('change', render);
    render();
  }

  function mount() { slider(); sources(); }

  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (main && e.detail.target === main) mount();
  });
  mount();
})();
