/* THE HOUR — motion for the landing page.
 *
 * The safety model, learned the hard way: this file ADDS the class that
 * makes elements hideable. The markup ships with no .rv anywhere, so a
 * browser that never executes this — or executes it and then fails —
 * renders the finished page. There is no state in which script failure
 * produces invisible text.
 *
 * .rv is inert on its own; only .in plays an animation. So every
 * failure mode — no observer, observer that never fires, throttled
 * timers, reduced-motion — lands on the same safe result: the finished
 * page, minus the entrance.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduce = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── 1. reveal on approach ─────────────────────────────────── */
  var targets = [];
  function collect(sel, delay) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
      if (targets.indexOf(el) !== -1) return;
      el.classList.add("rv");
      if (delay) el.classList.add(delay);
      targets.push(el);
    });
  }

  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("js");
    collect(".stage > .moment");
    collect(".mega", "d1");
    collect(".stage > .say", "d1");
    collect(".acts", "d2");
    collect(".fine", "d3");
    collect(".panel", "d2");
    collect(".big", "d1");
    collect(".lane", "d1");
    collect(".say-wide");
    collect(".sweep-grid > *", "d1");
    collect(".owns > article", "d1");

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

    targets.forEach(function (el) { io.observe(el); });

    /* No timeout net any more, and none is needed: .rv does not hide
       anything, so an observer that never fires costs the entrance
       animation and nothing else. A net that itself depends on timers
       firing was never insurance in the first place — the environment
       that broke the observer throttled the timer too. */
  }

  /* ── 2. the clock spine ────────────────────────────────────────
     Scroll position drives a 60-minute readout. Decorative: the same
     times are printed as text in each section's .moment line. */
  var fill = document.getElementById("railFill");
  var now = document.getElementById("railNow");

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function tick() {
    if (!fill && !now) return;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var p = max > 0 ? Math.min(Math.max(window.pageYOffset / max, 0), 1) : 0;
    if (fill) fill.style.height = (p * 100).toFixed(1) + "%";
    if (now) now.textContent = pad(Math.round(p * 60)) + ":" +
      (p >= 1 ? "00" : pad(Math.floor((p * 60 % 1) * 60)));
  }

  var queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () { queued = false; tick(); });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  tick();

  /* ── 3. the applicant tallies ──────────────────────────────────
     The final number is already the element's text, so if this never
     runs the reader still sees 3 and 94 — the point of the section. */
  if (!reduce && "IntersectionObserver" in window) {
    var counters = document.querySelectorAll(".tally[data-to]");
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        cio.unobserve(e.target);
        var el = e.target;
        var to = parseInt(el.getAttribute("data-to"), 10);
        if (!isFinite(to)) return;
        var started = null;
        var dur = 900;
        (function step(ts) {
          if (started === null) started = ts;
          var t = Math.min((ts - started) / dur, 1);
          // ease-out so the number decelerates into place
          el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3)));
          if (t < 1) window.requestAnimationFrame(step);
          else el.textContent = to;
        })(performance.now());
      });
    }, { threshold: 0.5 });
    Array.prototype.forEach.call(counters, function (el) { cio.observe(el); });
  }
  /* ── 4. the sweep ──────────────────────────────────────────────
     A radar behind the hero: rings, a rotating arm, and blips that
     brighten as the arm passes them. Decorative only — the canvas is
     aria-hidden and painting nothing changes what the page says.

     Stops when scrolled away and when the tab is hidden, so an
     animation nobody is looking at is not burning a phone battery. */
  var cv = document.getElementById("radar");
  if (cv && cv.getContext && !reduce) {
    var ctx = cv.getContext("2d");
    var blips = [];
    for (var b = 0; b < 9; b++) {
      blips.push({ a: Math.random() * Math.PI * 2,
                   r: 0.22 + Math.random() * 0.72,
                   lit: 0 });
    }
    var arm = -Math.PI / 2, running = true, raf = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = cv.clientWidth || 400;
      cv.width = w * dpr; cv.height = w * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return w;
    }
    var W = size();
    window.addEventListener("resize", function () { W = size(); });

    function draw() {
      var c = W / 2, R = W / 2 - 2;
      ctx.clearRect(0, 0, W, W);

      ctx.strokeStyle = "rgba(130,139,173,.20)";
      ctx.lineWidth = 1;
      for (var i = 1; i <= 4; i++) {
        ctx.beginPath(); ctx.arc(c, c, R * i / 4, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
      ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();

      // the arm, as a fading wedge trailing the leading edge
      var g = ctx.createConicGradient
        ? ctx.createConicGradient(arm, c, c) : null;
      if (g) {
        g.addColorStop(0, "rgba(255,122,82,.34)");
        g.addColorStop(0.10, "rgba(255,122,82,0)");
        g.addColorStop(1, "rgba(255,122,82,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = "rgba(255,122,82,.75)";
      ctx.beginPath(); ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(arm) * R, c + Math.sin(arm) * R); ctx.stroke();

      blips.forEach(function (p) {
        var d = Math.abs(((arm - p.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d > Math.PI - 0.09) p.lit = 1;
        p.lit *= 0.982;
        var x = c + Math.cos(p.a) * R * p.r, y = c + Math.sin(p.a) * R * p.r;
        ctx.beginPath(); ctx.arc(x, y, 2.6 + p.lit * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,122,82," + (0.16 + p.lit * 0.8) + ")";
        ctx.fill();
      });

      arm += 0.0085;
      if (running) raf = window.requestAnimationFrame(draw);
    }
    draw();

    function pause(off) {
      if (off === running) return;
      running = !off;
      if (running) raf = window.requestAnimationFrame(draw);
      else window.cancelAnimationFrame(raf);
    }
    document.addEventListener("visibilitychange", function () {
      pause(document.hidden);
    });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (e) {
        pause(!e[0].isIntersecting);
      }, { threshold: 0 }).observe(cv);
    }
  }
})();
