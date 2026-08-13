// theme.js — light/dark toggle, remembered across visits.
(function () {
  var KEY = "jw-theme";
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {}

  function current() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function paint() {
    var label = document.getElementById("themeLabel");
    // The button offers the OTHER theme, so it is labelled with it.
    if (label) label.textContent = current() === "dark" ? "Light" : "Dark";
  }

  var btn = document.getElementById("themeBtn");
  if (btn) {
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      paint();
    });
  }
  paint();
})();
