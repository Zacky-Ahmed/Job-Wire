// ticker.js — live countdowns.
//
// The server renders an absolute timestamp in data-next; this counts it
// down every second so the page does not sit frozen between sweeps.
// Server stays the source of truth — this only formats.
//
// The interval and the listeners below are started ONCE and outlive every
// navigation, because the shell they belong to does. Nothing here may
// hold on to an element inside <main>: those are replaced wholesale on
// every tab change, and a captured reference would keep pointing at a
// detached node that nobody can see.
(function () {
  var clocks = [];
  // #nextSweep is in the topbar, which persists, so this one is safe to keep.
  var head = document.getElementById("nextSweep");
  function collectClocks() { clocks = Array.from(document.querySelectorAll("[data-next]")); }
  function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
  function mmss(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function tick() {
    if (document.hidden) return;
    var soonest = null;
    clocks.forEach(function (el) {
      var at = Number(el.dataset.next);
      if (!at) { setText(el, "held"); return; }
      var left = (at - Date.now()) / 1000;
      setText(el, left <= 0 ? "due now" : "T-" + mmss(left));
      if (soonest === null || at < soonest) soonest = at;
    });

    // The header countdown is the SERVER's answer, falling back to the
    // rows only if it did not supply one. Deriving it purely from
    // [data-next] meant it worked on /watches and nowhere else, so the
    // wire — the page people actually leave open — read "—" forever.
    if (head) {
      var at = Number(head.dataset.nextSweep) || soonest;
      setText(head,
        !at ? "—" :
        at - Date.now() <= 0 ? "due" : mmss((at - Date.now()) / 1000));
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

  collectClocks();
  tick();
  dedupeFlash();
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  // htmx swaps in fresh rows; re-bind to whatever just arrived. This
  // covers both the 15s wire poll and a whole-page navigation.
  document.body.addEventListener("htmx:afterSwap", function () {
    collectClocks();
    tick();
    dedupeFlash();
  });
})();

/* Live-wire failure state.
 *
 * htmx swallows a failed poll silently: the list just stops changing,
 * which looks exactly like a quiet morning. That is the same failure
 * shape the sweep itself has, and it deserves the same treatment —
 * say so rather than let the reader assume nothing is happening.
 *
 * #pollDead lives on the wire page, inside the swapped region, so it is
 * looked up per event rather than once. Held as a reference, the banner
 * bound on the first load would be a detached node the moment you visited
 * Watches and came back — and the failure it exists to report is exactly
 * the one nobody would notice was no longer being reported.
 */
(function () {
  function dead(on) {
    var el = document.getElementById("pollDead");
    if (el) el.hidden = !on;
  }
  document.body.addEventListener("htmx:sendError", function () { dead(true); });
  document.body.addEventListener("htmx:timeout", function () { dead(true); });
  document.body.addEventListener("htmx:responseError", function () { dead(true); });
  // Any successful poll clears it again.
  document.body.addEventListener("htmx:afterOnLoad", function (e) {
    if (e.detail && e.detail.xhr && e.detail.xhr.status < 400) dead(false);
  });
})();
