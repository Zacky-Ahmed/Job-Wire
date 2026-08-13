// theme.js — toggle only.
//
// The server already rendered the correct theme into <html data-theme>
// from the jw.theme cookie, so there is nothing to apply on load and no
// flash. This just flips it and writes the cookie back.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("themeBtn");
  if (!btn) return;

  function label() {
    var el = document.getElementById("themeLabel");
    // The button offers the OTHER theme, so it is named after it.
    if (el) el.textContent = root.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  }

  btn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    // One year, site-wide, so it survives navigation and return visits.
    document.cookie =
      "jw.theme=" + next + ";path=/;max-age=31536000;samesite=lax" +
      (location.protocol === "https:" ? ";secure" : "");
    label();
  });

  label();
})();
