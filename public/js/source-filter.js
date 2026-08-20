// source-filter.js
//
// Some sources only cover one country: John Keells and topjobs are Sri
// Lankan boards, and offering them to someone watching Germany is an
// invitation to build a watch that can never match anything.
//
// The country and the sources are chosen in the SAME form, so this cannot
// be decided once on the server — it has to follow the select. The server
// still re-validates on submit; this only stops you picking a combination
// that could not work.
(function () {
  var geo = document.getElementById("geo");
  var picker = document.querySelector(".srcs");
  if (!geo || !picker) return;

  var rows = [].slice.call(picker.querySelectorAll(".src[data-countries]"));
  var note = document.getElementById("srcHidden");

  function apply() {
    var country = geo.value;
    var hidden = 0;

    rows.forEach(function (row) {
      var list = (row.dataset.countries || "").split(",").filter(Boolean);
      var ok = list.length === 0 || list.indexOf(country) !== -1;
      row.hidden = !ok;

      // Untick what is no longer on offer, or the box stays checked while
      // invisible and the form posts a source the country cannot use.
      var box = row.querySelector("input[type=checkbox]");
      if (!ok && box && box.checked) { box.checked = false; hidden++; }
    });

    if (note) {
      var off = rows.filter(function (r) { return r.hidden; }).length;
      note.hidden = off === 0;
      note.textContent = off
        ? " Some local boards are hidden — they only cover other countries."
        : "";
    }

    // Never leave the form with nothing selected.
    var any = rows.some(function (r) {
      var b = r.querySelector("input[type=checkbox]");
      return b && b.checked && !r.hidden;
    });
    if (!any) {
      var first = rows.filter(function (r) { return !r.hidden; })[0];
      if (first) first.querySelector("input[type=checkbox]").checked = true;
    }
  }

  geo.addEventListener("change", apply);
  apply();
})();
