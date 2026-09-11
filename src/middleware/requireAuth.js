// requireAuth.js
//
// Guards every app route. The verified check is the load-bearing part:
// without it an account that never confirmed its email reaches the
// dashboard, and the whole point of the OTP step disappears.

import { collections } from "../config/db.js";
import { oid } from "../utils/sanitize.js";
import { isAdmin } from "./requireAdmin.js";

export async function requireAuth(req, res, next) {
  const id = oid(req.session?.userId);
  if (!id) return bounce(req, res, "/signin");

  const user = await collections.users().findOne(
    { _id: id },
    { projection: { passHash: 0, otpHash: 0 } } // never load secrets we don't need
  );

  /* THE PASSWORD CHANGED SINCE THIS SESSION WAS ISSUED.

     Resetting a password is the clearest way somebody says "lock this
     account down", and until this check existed it did not mean that: a
     stolen session went on working until it expired on its own, which is
     precisely the window the owner was trying to close.

     Absent on both sides is treated as equal, so accounts that predate
     the counter are not all signed out on deploy. A session that carries
     no version against a user who now has one has, by definition, been
     issued before the change. */
  if (user) {
    const issued = req.session.sessionVersion ?? 0;
    const current = user.sessionVersion ?? 0;
    if (issued !== current) {
      req.session.destroy(() => {});
      return bounce(req, res, "/signin?err=stale");
    }
  }

  // Session outlived the account (deleted user, wiped database).
  if (!user) {
    req.session.destroy(() => {});
    return bounce(req, res, "/signin");
  }

  if (!user.verified) return bounce(req, res, "/verify");

  req.user = user;
  res.locals.user = user;
  // Every authenticated page needs this, not just /admin — it decides
  // whether the Admin tab renders. The route still guards itself; this
  // only controls whether the link is drawn.
  res.locals.isAdmin = isAdmin(user);
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
