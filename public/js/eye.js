// eye.js — show/hide password. HTMX does not do client-side interactivity.
(function () {
  var OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
    '<path d="M2 12s3.6-6.4 10-6.4S22 12 22 12s-3.6 6.4-10 6.4S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  var SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
    '<path d="M4 4.5l16 15"/><path d="M9.5 6A9.4 9.4 0 0 1 12 5.6c6.4 0 10 6.4 10 6.4a17 17 0 0 1-3.4 3.9"/>' +
    '<path d="M6.3 8.1A16.5 16.5 0 0 0 2 12s3.6 6.4 10 6.4c1.3 0 2.4-.2 3.4-.6"/>' +
    '<path d="M10.2 10.3a2.5 2.5 0 0 0 3.4 3.5"/></svg>';

  document.querySelectorAll(".eye[data-eye]").forEach(function (b) {
    b.innerHTML = SHUT;
    b.addEventListener("click", function () {
      var i = document.getElementById(b.dataset.eye);
      if (!i) return;
      var show = i.type === "password";
      i.type = show ? "text" : "password";
      b.innerHTML = show ? OPEN : SHUT;
      b.setAttribute("aria-pressed", String(show));
      b.setAttribute("aria-label", show ? "Hide password" : "Show password");
      i.focus();
    });
  });

  // Live password feedback. The server validates again — this is only UX.
  var pw = document.getElementById("pw"), pw2 = document.getElementById("pw2");
  var meter = document.getElementById("meter");
  var msg = document.getElementById("pwMsg"), msg2 = document.getElementById("pw2Msg");
  if (!pw || !meter) return;

  function score(p) {
    var s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d|[^\w]/.test(p)) s++;
    return Math.min(4, s);
  }
  function paint() {
    var p = pw.value;
    meter.hidden = !p;
    var s = score(p), cls = s <= 1 ? "s1" : s <= 2 ? "s2" : "s3";
    meter.querySelectorAll("i").forEach(function (i, x) { i.className = x < s ? cls : ""; });
    if (msg) {
      msg.className = "msg" + (p && p.length < 8 ? " err" : p ? " good" : "");
      msg.textContent = !p ? "" : p.length < 8 ? "Too short — 8 minimum"
        : ["", "Weak", "Weak", "Decent", "Strong"][s];
    }
    if (pw2 && msg2) {
      msg2.className = "msg" + (pw2.value ? (pw2.value === p ? " good" : " err") : "");
      msg2.textContent = !pw2.value ? "" : pw2.value === p ? "Match" : "Does not match";
    }
  }
  pw.addEventListener("input", paint);
  if (pw2) pw2.addEventListener("input", paint);
})();
