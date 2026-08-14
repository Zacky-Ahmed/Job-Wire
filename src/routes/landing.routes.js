// landing.routes.js
//
// The public front door. Previously "/" redirected to /wire, which
// bounced an unauthenticated visitor to a signup form with no
// explanation of what they were signing up for.
//
// Signed-in users skip it entirely — once you have an account, the
// marketing page is just an obstacle between you and the wire.

import { Router } from "express";
import { page } from "../utils/render.js";

export const landingRoutes = Router();

landingRoutes.get("/", (req, res) => {
  if (req.session?.userId) return res.redirect("/wire");
  page(res, "pages/landing", { title: "Job Wire — be early, by default" }, "layouts/public");
});
