// timing.js
//
// Where a request actually spends its time, reported as Server-Timing so
// the browser's own network panel shows the breakdown per stage.
//
// This exists because "the admin page feels slow" is not a fault report.
// It could be Mongo, the shaping loops afterwards, EJS, the redirect that
// follows every mutation, or simply that a hard navigation throws away a
// perfectly good page and rebuilds it. Those have completely different
// fixes, and guessing between them is how you rewrite a frontend and
// discover the database was the problem.
//
// Deliberately cheap: hrtime marks and a header. No sampling store, no
// dependency. It can stay switched on.

/** Header-safe: Server-Timing names are tokens, not prose. */
const token = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);

export function startTimer() {
  const t0 = process.hrtime.bigint();
  let last = t0;
  const marks = [];
  const ms = (a, b) => Number(b - a) / 1e6;

  return {
    /** Close off a stage and name it. */
    mark(name) {
      const now = process.hrtime.bigint();
      marks.push([token(name), ms(last, now)]);
      last = now;
      return this;
    },

    /** Time one awaited stage without hand-placing two marks around it. */
    async step(name, fn) {
      const started = process.hrtime.bigint();
      try {
        return await fn();
      } finally {
        const now = process.hrtime.bigint();
        marks.push([token(name), ms(started, now)]);
        last = now;
      }
    },

    totalMs() {
      return ms(t0, process.hrtime.bigint());
    },

    /** Server-Timing value, with the total last so it reads as a sum. */
    header() {
      const parts = marks.map(([n, d]) => `${n};dur=${d.toFixed(1)}`);
      parts.push(`total;dur=${this.totalMs().toFixed(1)}`);
      return parts.join(", ");
    },
  };
}

/**
 * Attach a timer to every request and stamp the header on the way out.
 *
 * res.send and res.redirect are wrapped rather than asking every route to
 * remember: a mutation that redirects is exactly the path being measured,
 * and it is the one nobody would think to instrument by hand.
 */
export function timing(req, res, next) {
  const t = startTimer();
  res.locals.t = t;

  let stamped = false;
  const stamp = () => {
    if (stamped || res.headersSent) return;
    stamped = true;
    try { res.set("Server-Timing", t.header()); } catch { /* headers gone */ }
  };

  const send = res.send.bind(res);
  res.send = (...args) => { stamp(); return send(...args); };
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => { stamp(); return redirect(...args); };

  next();
}
