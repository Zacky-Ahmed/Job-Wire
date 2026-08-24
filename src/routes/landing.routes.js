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
import { env } from "../config/env.js";

export const landingRoutes = Router();

/** The site's own address, without a trailing slash. */
function origin() {
  return String(env.appUrl || "").replace(/\/+$/, "");
}

landingRoutes.get("/", (req, res) => {
  if (req.session?.userId) return res.redirect("/wire");
  page(res, "pages/landing", { title: "Job Wire — be early, by default" }, "layouts/public");
});

/**
 * Everything behind a login is off-limits to crawlers.
 *
 * Not for secrecy — those routes already refuse anonymous requests — but
 * because a search engine that crawls them indexes the sign-in redirect
 * instead of the page, and spends its crawl budget on doors it cannot
 * open. The one page worth indexing is the landing page.
 *
 * Generated rather than shipped as a static file so the sitemap line
 * names whatever host the app is actually deployed under.
 */
landingRoutes.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Allow: /$",
    "Disallow: /wire",
    "Disallow: /watches",
    "Disallow: /admin",
    "Disallow: /settings",
    "Disallow: /signin",
    "Disallow: /signup",
    "Disallow: /reset",
    "Disallow: /verify",
    "",
    `Sitemap: ${origin()}/sitemap.xml`,
    "",
  ].join("\n"));
});

landingRoutes.get("/sitemap.xml", (req, res) => {
  // One public URL. Listing the gated routes here would contradict
  // robots.txt and is the most common way a small site gets flagged.
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin()}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
  res.type("application/xml").send(body);
});
