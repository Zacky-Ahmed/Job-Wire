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

    // The header countdown is the SERVER's answer, falling back to the
    // rows only if it did not supply one. Deriving it purely from
    // [data-next] meant it worked on /watches and nowhere else, so the
    // wire — the page people actually leave open — read "—" forever.
    var head = document.getElementById("nextSweep");
    if (head) {
      var at = Number(head.dataset.nextSweep) || soonest;
      head.textContent =
        !at ? "—" :
        at - Date.now() <= 0 ? "due" : mmss((at - Date.now()) / 1000);
    }
  }

  /* Flash each arrival ONCE.
     isNew stays true for five minutes and htmx replaces the whole list
     every fifteen seconds, so the CSS animation restarted on every poll
     and a new row strobed roughly twenty times before settling. Remember
     which jobs have already been announced and strip the class off the
     rest as they come back. */
  var announced = Object.create(null);
  function dedupeFlash() {
    var rows = document.querySelectorAll(".r-wire[data-job]");
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute("data-job");
      if (!rows[i].classList.contains("new")) { announced[id] = 1; continue; }
      if (announced[id]) rows[i].classList.remove("new");
      else announced[id] = 1;
    }
  }

  tick();
  dedupeFlash();
  setInterval(tick, 1000);
  // htmx swaps in fresh rows; re-bind to whatever just arrived
  document.body.addEventListener("htmx:afterSwap", function () {
    tick();
    dedupeFlash();
  });
})();
