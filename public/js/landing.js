// landing.js — everything that moves on the public page.
//
// Hand-written on purpose: the CSP is `script-src 'self'`, so there is no
// animation library available and no CDN to pull one from. That is a
// constraint worth keeping — the whole file is ~7KB and the page has no
// third party watching visitors arrive.
//
// One rule throughout: if a reader has asked for reduced motion, nothing
// here starts. The page is decoration over content that already reads.

(function () {
  "use strict";

  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };

  // ── reveal on scroll ────────────────────────────────────────
  // Also drives the one-shot animations (pile, source bars) so nothing
  // plays above the fold before anyone has seen it.
  var seen = new WeakSet();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting || seen.has(e.target)) return;
      seen.add(e.target);
      e.target.classList.add("in");
      if (e.target.id === "pileCanvas") drawPile();
      if (e.target.classList.contains("srcs")) fillSourceBars();
      if (e.target.classList.contains("figs")) countFigures();
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });

  var reveals = [].slice.call(document.querySelectorAll(".rv"));
  reveals.forEach(function (el) {
    if (still) { el.classList.add("in"); } else { io.observe(el); }
  });

  /* SAFETY NET.
     Every .rv element starts at opacity 0 and only becomes visible when
     IntersectionObserver reports it. That makes the observer load-bearing
     for READING THE PAGE, not just for the animation — and an observer
     that silently never fires leaves a visitor staring at a blank screen.
     Observed exactly that in one browser while testing this.
     So after a beat, reveal anything still hidden. If the observer is
     working this does nothing, because `seen` already holds them. */
  setTimeout(function () {
    reveals.forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el);
      el.classList.add("in");
      /* Written inline as well as via the class. The class only reveals
         through a CSS transition, so a browser that is not running
         transitions keeps the content at opacity 0 even once .in is set —
         the class says "revealed" while nothing is visible. Inline styles
         do not depend on anything animating. */
      el.style.opacity = "1";
      el.style.transform = "none";
      if (el.id === "pileCanvas") drawPile();
      if (el.classList.contains("srcs")) fillSourceBars();
      if (el.classList.contains("figs")) countFigures();
    });
  }, 1400);

  // ── the hour rail ───────────────────────────────────────────
  // Scroll position IS the hour. Minute sixty is the bottom of the page.
  var hourFill = $("hourFill"), hourMin = $("hourMin"), hourRead = $("hourRead");
  if (hourFill) {
    var hero = $("hero");
    var railTick = function () {
      var max = document.documentElement.scrollHeight - innerHeight;
      var p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
      hourFill.style.transform = "scaleX(" + p + ")";
      hourFill.style.background =
        p < .34 ? "var(--go)" : p < .72 ? "var(--amber)" : "var(--sig)";
      if (hourMin) {
        var m = Math.round(p * 60);
        hourMin.textContent = (m < 10 ? "0" : "") + m;
      }
      if (hourRead) {
        // Hidden at the very top: the readout is a companion to scrolling,
        // and announcing "00 min" before anyone has moved is just clutter.
        hourRead.classList.toggle("on", scrollY > 120);
        var overHero = hero && scrollY < hero.offsetHeight - 60;
        hourRead.classList.toggle("night", !!overHero);
      }
    };
    addEventListener("scroll", railTick, { passive: true });
    addEventListener("resize", railTick, { passive: true });
    railTick();
  }

  // ── nav shadow ──────────────────────────────────────────────
  var nav = document.querySelector(".lp-nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("stuck", scrollY > 12); };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ── hero: the minute counter ────────────────────────────────
  // The one number on the page that moves by itself. It counts the
  // reader's own time on the page, which is the argument in miniature:
  // the window closed a little while you read the headline.
  var mins = $("heroMins");
  if (mins && !still) {
    var start = 4, opened = Date.now();
    setInterval(function () {
      var v = start + Math.floor((Date.now() - opened) / 45000);
      if (v > 59 || String(v) === mins.textContent) return;
      mins.textContent = v;
      mins.classList.remove("flip");
      void mins.offsetWidth;          // restart the animation
      mins.classList.add("flip");
    }, 1000);
  }

  // ── hero: the wire streams ──────────────────────────────────
  var ROLES = [
    ["2:14", "Software Engineering Intern", "Sysco LABS"],
    ["3:41", "Data Analyst Intern", "99x"],
    ["4:07", "Full Stack Developer Intern", "Niyamu"],
    ["1:52", "Intern — Business Intelligence", "MAS Holdings"],
    ["0:48", "Trainee Software Engineer", "Fidenz"],
    ["3:16", "Intern — Human Resources", "John Keells"],
    ["2:39", "UI/UX Engineer — Intern", "Axceera"],
    ["1:07", "Marketing Intern", "PickMe"]
  ];
  var rows = $("wireRows");
  if (rows) {
    var at = 0;
    var push = function (animate) {
      var r = ROLES[at % ROLES.length]; at++;
      var el = document.createElement("div");
      el.className = "wire-row";
      if (!animate) el.style.animation = "none";
      var lead = document.createElement("span");
      lead.className = "wire-lead tnum"; lead.textContent = r[0];
      var role = document.createElement("span");
      role.className = "wire-role"; role.textContent = r[1];
      var co = document.createElement("span");
      co.className = "wire-co"; co.textContent = r[2];
      el.appendChild(lead); el.appendChild(role); el.appendChild(co);
      rows.insertBefore(el, rows.firstChild);
      while (rows.children.length > 4) rows.removeChild(rows.lastChild);
    };
    push(false); push(false); push(false);
    if (!still) setInterval(function () { push(true); }, 3600);
  }

  // ── hero: the T-minus clock ─────────────────────────────────
  var wc = $("wireClock");
  if (wc && !still) {
    var left = 298;
    setInterval(function () {
      left = left <= 0 ? 298 : left - 1;
      var m = Math.floor(left / 60), s = left % 60;
      wc.textContent = "T-" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }, 1000);
  }

  // ── hero: aurora ────────────────────────────────────────────
  // Three slow blobs on a canvas rather than animated CSS gradients,
  // which repaint the whole layer every frame and stutter on a phone.
  /* Canvas backing stores must follow LAYOUT, not script order.
     Sizing once at parse time measured the aurora at 1px wide and the CTA
     at 0px, so both animated every frame into a canvas with no pixels in
     it — silently, because a zero-size canvas throws nothing.

     So measure on every signal available and trust none of them alone:
     immediately, again on the next frame once layout has run, on window
     resize, and via ResizeObserver where the element's own box changes
     without the window doing anything. An observer-only version looked
     correct and sized nothing at all in a browser that never fired it. */
  function onSize(el, fn) {
    fn();                        // now — never depend on an observer firing
    requestAnimationFrame(fn);   // again once the first layout pass is done
    addEventListener("resize", fn, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(fn).observe(el);
  }

  var aur = $("aurora");
  if (aur && !still) {
    var ac = aur.getContext("2d"), blobs, W, H, mx = 0.5, my = 0.4, raf = 0;
    var css = function (n) {
      return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    };
    var size = function () {
      var r = aur.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
      W = aur.width = Math.max(1, Math.round(r.width * d));
      H = aur.height = Math.max(1, Math.round(r.height * d));
      ac.setTransform(d, 0, 0, d, 0, 0);
      W = r.width; H = r.height;
    };
    var build = function () {
      blobs = [
        { c: css("--lp-glow-1"), x: .22, y: .30, r: .46, sx: .00013, sy: .00009, p: 0 },
        { c: css("--lp-glow-2"), x: .78, y: .22, r: .40, sx: .00010, sy: .00015, p: 2 },
        { c: css("--lp-glow-3"), x: .58, y: .74, r: .34, sx: .00016, sy: .00007, p: 4 }
      ];
    };
    var frame = function (t) {
      ac.clearRect(0, 0, W, H);
      blobs.forEach(function (b) {
        var x = (b.x + Math.sin(t * b.sx + b.p) * .07 + (mx - .5) * .045) * W;
        var y = (b.y + Math.cos(t * b.sy + b.p) * .06 + (my - .5) * .035) * H;
        var rad = b.r * Math.max(W, H);
        var g = ac.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, b.c);
        g.addColorStop(1, "transparent");
        ac.fillStyle = g;
        ac.fillRect(0, 0, W, H);
      });
      raf = requestAnimationFrame(frame);
    };
    onSize(aur, size); build(); raf = requestAnimationFrame(frame);
    addEventListener("pointermove", function (e) {
      mx = e.clientX / innerWidth; my = e.clientY / innerHeight;
    }, { passive: true });
    // The palette changes under us when the theme is toggled.
    new MutationObserver(build).observe(document.documentElement,
      { attributes: true, attributeFilter: ["data-theme"] });
    // Stop burning frames once the hero has scrolled away.
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !raf) raf = requestAnimationFrame(frame);
        else if (!e.isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
      });
    }, { threshold: 0 }).observe(aur);
  }

  // ── the pile ────────────────────────────────────────────────
  // 200 applicants arriving across an hour, drawn one at a time. You
  // are the coral one at minute four. The whole argument in one figure.
  var pile = $("pileCanvas");
  var pileCount = $("pileCount");
  function drawPile() {
    if (!pile) return;
    var c = pile.getContext("2d");
    var r = pile.getBoundingClientRect();
    var d = Math.min(devicePixelRatio || 1, 2);
    pile.width = Math.round(r.width * d);
    pile.height = Math.round(r.height * d);
    c.setTransform(d, 0, 0, d, 0, 0);
    var W = r.width, H = r.height;

    var TOTAL = 200, YOU = 9, COLS = Math.floor(W / 15) || 20;
    var gap = W / COLS, rows2 = Math.ceil(TOTAL / COLS), rh = Math.min(15, H / rows2);
    var dim = getComputedStyle(document.documentElement).getPropertyValue("--line-2").trim();
    var sig = getComputedStyle(document.documentElement).getPropertyValue("--sig").trim();

    var n = 0;
    var step = function () {
      var batch = still ? TOTAL : Math.max(1, Math.round(n / 26) + 1);
      for (var k = 0; k < batch && n < TOTAL; k++, n++) {
        var col = n % COLS, row = Math.floor(n / COLS);
        var x = col * gap + gap / 2, y = H - (row * rh + rh / 2) - 2;
        var you = n === YOU;
        c.beginPath();
        c.arc(x, y, you ? 4.6 : 3, 0, Math.PI * 2);
        c.fillStyle = you ? sig : dim;
        c.fill();
        if (you) {
          c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2);
          c.strokeStyle = sig; c.globalAlpha = .35; c.lineWidth = 1.5;
          c.stroke(); c.globalAlpha = 1;
        }
      }
      if (pileCount) pileCount.textContent = n + " applicants";
      if (n < TOTAL && !still) requestAnimationFrame(step);
    };
    step();
  }

  // ── source bars ─────────────────────────────────────────────
  function fillSourceBars() {
    [].forEach.call(document.querySelectorAll(".src-item"), function (li, i) {
      var bar = li.querySelector(".src-bar i");
      var pct = Number(li.dataset.lag || 10);
      setTimeout(function () { bar.style.width = pct + "%"; }, still ? 0 : 140 * i);
    });
  }

  // ── figures count up ────────────────────────────────────────
  function countFigures() {
    [].forEach.call(document.querySelectorAll(".fig-n[data-count]"), function (el) {
      var target = Number(el.dataset.count);
      var prefix = el.dataset.prefix ? el.dataset.prefix : "";
      var small = el.querySelector("small");
      var unit = small ? small.outerHTML : "";
      if (still || target === 0) { el.innerHTML = prefix + target + unit; return; }
      var v = 0;
      var t = setInterval(function () {
        v++;
        el.innerHTML = prefix + v + unit;
        if (v >= target) clearInterval(t);
      }, 90);
    });
  }

  // ── the hour, scrubbed by scroll ────────────────────────────
  // Moving down the page IS time passing. The numbers are a plausible
  // curve, not measured data, and the copy around them says so.
  var clock = $("clock"), fill = $("clockFill"), you = $("clockYou");
  var cMin = $("clockMin"), cApps = $("clockApps"), cVer = $("clockVerdict");
  if (clock && fill) {
    var tick = function () {
      var r = clock.getBoundingClientRect();
      var span = innerHeight + r.height;
      var p = Math.min(1, Math.max(0, (innerHeight - r.top) / span));
      var minute = Math.round(p * 60);
      // Applications arrive fast then taper — roughly the shape every
      // recruiter describes.
      var apps = Math.round(200 * Math.pow(p, 0.62));
      fill.style.width = (p * 100) + "%";
      if (you) you.style.left = (p * 100) + "%";
      if (cMin) cMin.textContent = minute;
      if (cApps) cApps.textContent = apps;
      if (cVer) {
        cVer.textContent =
          minute <= 8 ? "Wide open" :
          minute <= 20 ? "Still read" :
          minute <= 38 ? "Getting crowded" :
          minute <= 52 ? "Skimmed" : "Likely closed";
        cVer.style.color =
          minute <= 8 ? "var(--go)" :
          minute <= 38 ? "var(--amber)" : "var(--sig)";
      }
    };
    addEventListener("scroll", tick, { passive: true });
    addEventListener("resize", tick, { passive: true });
    tick();
  }

  // ── cta drift ───────────────────────────────────────────────
  var cta = $("ctaCanvas");
  if (cta && !still) {
    var cc = cta.getContext("2d"), dots = [], cw, ch, craf = 0;
    var csize = function () {
      var r = cta.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
      cta.width = Math.round(r.width * d); cta.height = Math.round(r.height * d);
      cc.setTransform(d, 0, 0, d, 0, 0); cw = r.width; ch = r.height;
      dots = [];
      var n = Math.round(cw / 26);
      for (var i = 0; i < n; i++) {
        dots.push({ x: Math.random() * cw, y: Math.random() * ch,
          r: Math.random() * 1.9 + .5, s: Math.random() * .22 + .05 });
      }
    };
    var cframe = function () {
      cc.clearRect(0, 0, cw, ch);
      cc.fillStyle = "rgba(255,255,255,.55)";
      dots.forEach(function (p) {
        p.y -= p.s;
        if (p.y < -4) { p.y = ch + 4; p.x = Math.random() * cw; }
        cc.beginPath(); cc.arc(p.x, p.y, p.r, 0, Math.PI * 2); cc.fill();
      });
      craf = requestAnimationFrame(cframe);
    };
    onSize(cta, csize); craf = requestAnimationFrame(cframe);
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !craf) craf = requestAnimationFrame(cframe);
        else if (!e.isIntersecting && craf) { cancelAnimationFrame(craf); craf = 0; }
      });
    }, { threshold: 0 }).observe(cta);
  }
})();
