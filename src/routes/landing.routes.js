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
import { collections } from "../config/db.js";
import * as SeenJobs from "../models/seenJobs.js";
import { getSource } from "../services/sources/index.js";
import { rel } from "../utils/time.js";
import { log } from "../utils/logger.js";

/* The landing page shows the real sweep, not an invented one.
 *
 * It used to carry four hardcoded rows I made up. A page whose entire
 * argument is "postings are minutes old" is far better served by an
 * actual posting that is actually minutes old — and if the sweep ever
 * stops, the page stops claiming otherwise, which is the honest failure.
 *
 * Cached, because this is the most-crawled route on the site and every
 * bot would otherwise cost two Mongo round trips.
 */
const SHOWCASE_TTL_MS = 60_000;
let showcase = { at: 0, jobs: [] };

async function recentJobs() {
  if (Date.now() - showcase.at < SHOWCASE_TTL_MS) return showcase.jobs;
  try {
    // Keyword watches only. A matchAll watch matches everything in the
    // country, which put a Chief Executive Officer on a page about
    // internships the first time this was tried.
    const ids = (await collections.queries()
      .find({ matchAll: { $ne: true } }, { projection: { _id: 1 } })
      .toArray()).map((q) => q._id);

    const rows = await SeenJobs.recentForShowcase(ids, 5);
    showcase = {
      at: Date.now(),
      jobs: rows.map((j) => ({
        title: j.title,
        company: j.company,
        /* City only. "Colombo, Western Province, Sri Lanka" plus the
           company plus the source wrapped every row onto two lines and
           pushed the panel out of the hero. The province and country add
           nothing on a page that already says which country it watches. */
        location: String(j.location || "").split(",")[0].trim(),
        source: getSource(String(j.jobId).split(":")[0])?.label || "a job board",
        age: rel(j.firstSeenAt),
      })),
    };
  } catch (err) {
    // Never let the marketing page fail on its decoration.
    log.warn("showcase feed unavailable", { message: err.message });
    showcase = { at: Date.now(), jobs: [] };
  }
  return showcase.jobs;
}

export const landingRoutes = Router();

/** The site's own address, without a trailing slash. */
function origin() {
  return String(env.appUrl || "").replace(/\/+$/, "");
}

landingRoutes.get("/", async (req, res) => {
  if (req.session?.userId) return res.redirect("/wire");
  page(res, "pages/landing", {
    title: "Job Wire — be early, by default",
    jobs: await recentJobs(),
  }, "layouts/public");
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
