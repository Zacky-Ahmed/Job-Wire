// landing.js
//
// All motion on the landing page. No library — IntersectionObserver for
// reveals and one scroll listener for the clock. Everything respects
// prefers-reduced-motion, and every animation is decoration: the page
// reads correctly with JavaScript switched off.
(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── reveal on scroll ───────────────────────────────────────
  var targets = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.1 });
    targets.forEach(function (el) { io.observe(el); });
  }

  // ── nav gets a rule once you leave the hero ────────────────
  var nav = document.querySelector(".lp-nav");
  function onScrollNav() {
    if (nav) nav.classList.toggle("stuck", window.scrollY > 8);
  }
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  // ── hero: minutes since the job was posted, ticking ────────
  // Small and slow on purpose — it should read as a live number, not
  // a stopwatch demanding attention.
  var heroMins = document.getElementById("heroMins");
  if (heroMins && !reduced) {
    var m = 4;
    setInterval(function () {
      m = m >= 9 ? 3 : m + 1;
      heroMins.textContent = m;
    }, 3800);
  }

  // ── hero panel: a countdown that behaves like the real one ──
  var clockEl = document.getElementById("hpClock");
  if (clockEl && !reduced) {
    var left = 298;
    setInterval(function () {
      left = left <= 0 ? 300 : left - 1;
      var mm = Math.floor(left / 60), ss = left % 60;
      clockEl.textContent = "T-" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    }, 1000);
  }

  // ── the clock: scroll position drives the hour ─────────────
  // The section's progress through the viewport maps to 0-60 minutes,
  // so scrolling *is* time passing. Applicant count follows a curve
  // that is steep early and flattens, which is how postings actually
  // fill up.
  var clock = document.getElementById("clock");
  var fill = document.getElementById("clockFill");
  var you = document.getElementById("clockYou");
  var outMin = document.getElementById("clockMin");
  var outApps = document.getElementById("clockApps");
  var outVerdict = document.getElementById("clockVerdict");

  function paintClock() {
    if (!clock || !fill) return;
    var r = clock.getBoundingClientRect();
    var vh = window.innerHeight || 1;
    // 0 when the block's top reaches the middle of the screen,
    // 1 once it has travelled a further 70% of the viewport.
    var p = (vh * 0.62 - r.top) / (vh * 0.7);
    p = Math.max(0, Math.min(1, p));

    var mins = Math.round(p * 60);
    // Applications arrive fastest in the first minutes, then taper.
    var apps = Math.round(220 * (1 - Math.pow(1 - p, 1.9)));

    fill.style.width = p * 100 + "%";
    if (you) you.style.left = p * 100 + "%";
    if (outMin) outMin.textContent = mins;
    if (outApps) outApps.textContent = apps;
    if (outVerdict) {
      var v = mins <= 5 ? "Wide open"
            : mins <= 20 ? "Still good"
            : mins <= 40 ? "Closing"
            : "Buried";
      outVerdict.textContent = v;
      outVerdict.style.color =
        mins <= 5 ? "var(--go)" : mins <= 20 ? "var(--vio)"
        : mins <= 40 ? "var(--amber)" : "var(--sig)";
    }
  }

  if (clock) {
    if (reduced) {
      // Show the end state rather than animating to it.
      fill.style.width = "100%";
      if (you) you.style.left = "100%";
      if (outMin) outMin.textContent = "60";
      if (outApps) outApps.textContent = "220";
      if (outVerdict) outVerdict.textContent = "Buried";
    } else {
      var ticking = false;
      window.addEventListener("scroll", function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { paintClock(); ticking = false; });
      }, { passive: true });
      window.addEventListener("resize", paintClock);
      paintClock();
    }
  }
})();
