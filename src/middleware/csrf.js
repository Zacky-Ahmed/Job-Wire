// csrf.js
//
// sameSite=lax already blocks cross-site POSTs in every current browser,
// but it is one flag away from being the only thing protecting every
// state-changing route. This adds a synchronizer token as the second layer.
//
// HTMX sends it automatically — the layout sets:
//   <body hx-headers='{"x-csrf-token": "<%= csrfToken %>"}'>
// so every hx-post/patch/delete carries the header with no per-form work.

import crypto from "crypto";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function mint(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  return req.session.csrfToken;
}

export function csrf(req, res, next) {
  /* Minted on FIRST READ, not on every request.
     Writing req.session.csrfToken unconditionally initialised the session
     on every GET, and an initialised session gets persisted even with
     saveUninitialized:false. So /healthz, /, /robots.txt and every crawler
     hit wrote a 14-day session document: 1,140 of 1,165 rows in the
     collection had no userId at all.
     A getter means only a response that actually renders the token — a
     page with a form — pays for a session. */
  Object.defineProperty(res.locals, "csrfToken", {
    configurable: true,
    enumerable: true,
    get() { return mint(req); },
  });

  if (SAFE.has(req.method)) return next();

  const sent =
    req.get("x-csrf-token") ||
    (req.body && typeof req.body._csrf === "string" ? req.body._csrf : "");

  // An unsafe request must compare against a real token, so mint here
  // too: a POST arriving on a brand-new session has nothing to match and
  // is rejected below rather than crashing on an undefined length.
  const expected = mint(req);
  const ok =
    sent.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));

  if (!ok) {
    return res.status(403).type("text/html").send(
      `<div class="msg err">Your session expired. Reload the page and try again.</div>`
    );
  }
  next();
}
