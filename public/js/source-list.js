// source-list.js
//
// Says which sites this watch will cover. It used to be a row of
// checkboxes, which asked the reader to make a decision they had no
// basis for — nobody wants fewer places searched for the same keyword,
// and picking a Sri Lankan board for a German watch just built something
// that could never match.
//
// The country decides, so this only reports. The server derives the same
// list independently; nothing here is submitted.
(function () {
  var geo = document.getElementById("geo");
  var out = document.getElementById("srcList");
  if (!geo || !out) return;

  var sources = [];
  try { sources = JSON.parse(out.dataset.sources || "[]"); } catch (e) { return; }

  function render() {
    var country = geo.value;
    var live = sources.filter(function (s) {
      return !s.countries || !s.countries.length || s.countries.indexOf(country) !== -1;
    });

    out.innerHTML = "";
    live.forEach(function (s) {
      var row = document.createElement("span");
      row.className = "srcs-chip";
      var n = document.createElement("b");
      n.textContent = s.label;
      row.appendChild(n);
      if (s.note) {
        var h = document.createElement("i");
        h.textContent = s.note;
        row.appendChild(h);
      }
      out.appendChild(row);
    });
  }

  geo.addEventListener("change", render);
  render();
})();
