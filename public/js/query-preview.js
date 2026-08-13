// query-preview.js — live LinkedIn URL as the form changes.
// Mirrors src/services/linkedin/buildUrl.js; the server is authoritative.
(function () {
  var kw = document.getElementById("kw"), geo = document.getElementById("geo");
  var every = document.getElementById("every"), out = document.getElementById("urlOut");
  var why = document.getElementById("whyOut"), everyOut = document.getElementById("everyOut");
  if (!kw || !geo || !every || !out) return;

  var WINDOWS = [3600, 7200, 14400, 86400];
  function tprFor(mins) {
    var need = mins * 60 * 4;
    for (var i = 0; i < WINDOWS.length; i++) if (need <= WINDOWS[i]) return WINDOWS[i];
    return 86400;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function paint() {
    var mins = Number(every.value);
    var words = kw.value.split(",").map(function (s) { return s.trim(); })
      .filter(Boolean).join(" ") || "…";
    var country = geo.options[geo.selectedIndex].text.replace(" (unverified geoId)", "");
    var tpr = tprFor(mins);
    everyOut.textContent = mins + " min";
    out.innerHTML = "linkedin.com/jobs/search?keywords=<b>" + esc(encodeURIComponent(words)) +
      "</b>&amp;location=<b>" + esc(encodeURIComponent(country)) +
      "</b>&amp;geoId=<b>" + esc(geo.value) + "</b>&amp;f_TPR=<b>r" + tpr + "</b>&amp;sortBy=DD";
    why.textContent = "r" + tpr + " = " + (tpr / 3600) + "h window, about " +
      Math.round(tpr / 60 / mins) + "x the sweep gap. A job posted just after one " +
      "sweep cannot age out before the next.";
  }
  [kw, geo, every].forEach(function (el) {
    el.addEventListener("input", paint); el.addEventListener("change", paint);
  });
  paint();
})();
