// requireAuth.js
//
// Guards every app route. The verified check is the load-bearing part:
// without it an account that never confirmed its email reaches the
// dashboard, and the whole point of the OTP step disappears.

import { collections } from "../config/db.js";
import { oid } from "../utils/sanitize.js";

export async function requireAuth(req, res, next) {
  const id = oid(req.session?.userId);
  if (!id) return bounce(req, res, "/signin");

  const user = await collections.users().findOne(
    { _id: id },
    { projection: { passHash: 0, otpHash: 0 } } // never load secrets we don't need
  );

  // Session outlived the account (deleted user, wiped database).
  if (!user) {
    req.session.destroy(() => {});
    return bounce(req, res, "/signin");
  }

  if (!user.verified) return bounce(req, res, "/verify");

  req.user = user;
  res.locals.user = user;
  next();
}

/** Signed-in users should not see the signup or signin pages. */
export function redirectIfAuthed(req, res, next) {
  if (req.session?.userId) return res.redirect("/wire");
  next();
}

// HTMX needs a header to redirect; a normal request needs a 302.
function bounce(req, res, to) {
  if (req.get("HX-Request")) {
    res.set("HX-Redirect", to);
    return res.status(204).end();
  }
  return res.redirect(to);
}
