// requireAdmin.js
//
// Sits behind requireAuth, never instead of it: admin is an extra check
// on an already-authenticated, already-verified session.
//
// Membership comes from ADMIN_EMAILS in the environment rather than a
// column in the users collection. That means no bootstrap ceremony for
// the first admin, and — more importantly — nothing that can write to the
// database can promote itself.

import { page } from "../utils/render.js";
import { env } from "../config/env.js";

export function isAdmin(user) {
  if (!user?.email || !env.adminEmails.length) return false;
  return env.adminEmails.includes(String(user.email).toLowerCase());
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();

  // 404, not 403. A signed-in non-admin has no business learning that an
  // admin area exists at this URL, and "forbidden" confirms that it does.
  res.status(404);
  if (req.get("HX-Request") || !req.accepts("html")) {
    return res.type("text/plain").send("Not found");
  }
  return page(res, "pages/404", { title: "Not found — Job Wire" }, "layouts/public");
}
