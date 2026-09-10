// watches.routes.js
//
// A "watch" the user sees is a subscription. The LinkedIn query behind
// it is shared: two users with the same keywords and country point at
// one query row, so the poller fetches once and fans out.

import { Router } from "express";
import { page } from "../utils/render.js";
import { str, keywords as cleanKeywords, int, oid } from "../utils/sanitize.js";
import { requireAuth } from "../middleware/requireAuth.js";
import * as Queries from "../models/queries.js";
import * as Subs from "../models/subscriptions.js";
import { selectableCountries, isKnownGeo, findGeo } from "../services/linkedin/geoIds.js";

const DEFAULT_GEO = "100446352"; // Sri Lanka
import { canonicalKey, tprFor } from "../services/linkedin/buildUrl.js";
import { listSources, getSource, sourcesForCountry, DEFAULT_SOURCE } from "../services/sources/index.js";
import { rel, countdown } from "../utils/time.js";
import { headerState } from "../utils/header.js";
import { env } from "../config/env.js";

export const watchesRoutes = Router();

// Per route, not router-wide — see the note in wire.routes.js.

async function render(req, res, extra = {}) {
  const watches = await Subs.listForUser(req.user._id);
  res.locals.t?.mark("db-watches");
  page(res, "pages/watches", {
    title: "Watches",
    nav: "watches",
    user: req.user,
    watches,
    ...headerState(watches, env.pollerEnabled),
    pollerEnabled: env.pollerEnabled,
    countries: selectableCountries(),
    sources: listSources(),
    // Without this the <select> defaults to whatever sorts first
    // (Argentina), which is nobody's intent. DEFAULT_GEO is the home
    // market; a real product would infer it from the request's locale.
    defaultGeo: DEFAULT_GEO,
    minSweep: sliderFloor(),
    showNew: extra.showNew ?? false,
    error: extra.error || null,
    notice: extra.notice || null,
    values: extra.values || {},
    tprFor, rel,
    sourceLabel: (id) => getSource(id)?.label || id,
  });
}

/* What the slider offers, which is not the same as what the app will
 * tolerate.
 *
 * MIN_SWEEP_MINUTES is a safety floor an operator can lower; this is a
 * product decision and does not move. Below five minutes the interval is
 * a promise the boards will not keep — LinkedIn's public index runs a
 * measured median of 19 minutes behind, so a two minute sweep asks seven
 * times as often to see the same jobs — and it is how searches get
 * throttled, which costs everyone coverage. Offering 1-4 invited people
 * to pick a number that helps nobody.
 *
 * Math.max, not a constant, so raising MIN_SWEEP_MINUTES above five still
 * raises the slider with it.
 */
const SLIDER_MIN_MINUTES = 5;
const sliderFloor = () => Math.max(SLIDER_MIN_MINUTES, env.minSweepMinutes);

/**
 * Answer a hold, resume or delete.
 *
 * Two answers to the same request, chosen by what asked. A form posted
 * by the browser gets the redirect it has always got — no script, no
 * htmx, still works, still lands on a correct page. A form posted by
 * htmx gets the list back, plus the two things elsewhere on the page
 * that this mutation genuinely invalidated: the panel's live dot and the
 * topbar readouts.
 *
 * The list is re-read rather than patched in place. Holding a watch can
 * change the next sweep time of a query shared with other people, and
 * guessing what that became would be a lie told confidently.
 */
async function respondList(req, res) {
  if (req.get("hx-target") !== "watchList") return res.redirect("/watches");
  const watches = await Subs.listForUser(req.user._id);
  res.vary("HX-Target");
  return res.render("partials/watch-list-swap", {
    watches,
    ...headerState(watches, env.pollerEnabled),
    csrfToken: res.locals.csrfToken,
    tprFor, rel,
    sourceLabel: (id) => getSource(id)?.label || id,
  }, (err, html) => {
    if (err) return req.next(err);
    res.type("text/html").send(html);
  });
}

watchesRoutes.get("/watches", requireAuth, (req, res, next) =>
  render(req, res, { showNew: req.query.new === "1" }).catch(next)
);

watchesRoutes.post("/watches", requireAuth, async (req, res, next) => {
  try {
    const label = str(req.body.label, { max: 80 });
    const kw = cleanKeywords(req.body.keywords);
    const geoId = str(req.body.geoId, { max: 20 });

    // Not asked, derived. Whatever the request says about sources is
    // ignored: nobody wants FEWER sites searched for the same keyword,
    // and a hand-written POST cannot attach a Sri Lankan board to a
    // German watch when the country is the only thing that decides.
    const sources = sourcesForCountry(geoId);
    if (!sources.length) sources.push(DEFAULT_SOURCE);
    // Clamped to the same floor the slider shows, so a hand-written POST
    // cannot ask for the interval the form deliberately stopped offering.
    const every = int(req.body.every, {
      min: sliderFloor(), max: 60, fallback: env.defaultSweepMinutes,
    });
    // Deliberately opt-in. A keyword can only ever be matched against a
    // job TITLE, and employers routinely tag a job "Internship" while
    // calling it "Real Estate Sales Agent" — that one shows in a
    // logged-in search for "intern" and no title filter on earth finds
    // it. This is the only setting that catches those.
    /* No longer offered, and no longer accepted.
     *
     * "Send me every job in the country" was a checkbox on this form. It
     * confused people — it silently ignored the keywords they had just
     * typed — and it was expensive in a way nothing on screen admitted:
     * a match-all watch fetches the country's whole listing, which for
     * Sri Lanka is around 400 jobs a sweep and roughly seventy emails a
     * day per subscriber.
     *
     * Hardcoded rather than read-and-ignored so a hand-written POST
     * cannot set it either. Existing match-all rows still work; the code
     * that serves them is untouched. */
    const matchAll = false;
    const values = { label, keywords: str(req.body.keywords, { max: 600 }), geoId, every, matchAll };

    if (!label)
      return render(req, res, { showNew: true, values, error: "Give it a name so you can tell watches apart." });
    if (!kw.length)
      return render(req, res, { showNew: true, values, error: "At least one keyword, so we know what to watch for." });
    if (!isKnownGeo(geoId))
      return render(req, res, { showNew: true, values, error: "Pick a country from the list." });

    const geo = findGeo(geoId);
    const query = await Queries.upsert({
      // matchAll changes WHICH jobs a query yields, so two watches that
      // differ only by it must not share a row.
      // Keywords + country decide identity. Sources are derived from the
      // country, so including them would change the key the moment a new
      // adapter shipped and quietly split one shared query into two.
      keywordsKey: canonicalKey(kw) + (matchAll ? "@@all" : ""),
      keywords: kw,
      geoId,
      location: geo.name,
      everyMinutes: every,
      sources,
      matchAll,
    });

    const sub = await Subs.create({ userId: req.user._id, queryId: query._id, label });
    if (!sub)
      return render(req, res, { showNew: true, values, error: "You already watch this exact query." });

    return render(req, res, {
      notice: `Watch created. The first sweep only memorises what is already there — alerts start after that.`,
    });
  } catch (err) {
    next(err);
  }
});

watchesRoutes.post("/watches/:id/toggle", requireAuth, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return respondList(req, res);
    const list = await Subs.listForUser(req.user._id);
    const current = list.find((s) => String(s._id) === String(id));
    if (current) await Subs.setActive(req.user._id, id, !current.active);
    return respondList(req, res);
  } catch (err) {
    next(err);
  }
});

watchesRoutes.post("/watches/:id/delete", requireAuth, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (id) await Subs.remove(req.user._id, id);
    return respondList(req, res);
  } catch (err) {
    next(err);
  }
});
