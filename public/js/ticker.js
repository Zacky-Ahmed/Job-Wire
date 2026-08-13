// ticker.js — live countdowns.
//
// The server renders an absolute timestamp in data-next; this counts it
// down every second so the page does not sit frozen between sweeps.
// Server stays the source of truth — this only formats.
(function () {
  function mmss(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function tick() {
    var soonest = null;
    document.querySelectorAll("[data-next]").forEach(function (el) {
      var at = Number(el.dataset.next);
      if (!at) { el.textContent = "held"; return; }
      var left = (at - Date.now()) / 1000;
      el.textContent = left <= 0 ? "due now" : "T-" + mmss(left);
      if (soonest === null || at < soonest) soonest = at;
    });

    var head = document.getElementById("nextSweep");
    if (head) {
      head.textContent =
        soonest === null ? "—" :
        soonest - Date.now() <= 0 ? "due" : mmss((soonest - Date.now()) / 1000);
    }
  }

  tick();
  setInterval(tick, 1000);
  // htmx swaps in fresh rows; re-bind to whatever just arrived
  document.body.addEventListener("htmx:afterSwap", tick);
})();
