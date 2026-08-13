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

export function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  // Available to every template without passing it through each render call.
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE.has(req.method)) return next();

  const sent =
    req.get("x-csrf-token") ||
    (req.body && typeof req.body._csrf === "string" ? req.body._csrf : "");

  const expected = req.session.csrfToken;
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
