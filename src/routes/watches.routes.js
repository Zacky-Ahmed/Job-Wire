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
import { listSources, getSource, sourceCoversCountry, DEFAULT_SOURCE } from "../services/sources/index.js";
import { rel, countdown } from "../utils/time.js";
import { headerState } from "../utils/header.js";
import { env } from "../config/env.js";

export const watchesRoutes = Router();

// Per route, not router-wide — see the note in wire.routes.js.

async function render(req, res, extra = {}) {
  const watches = await Subs.listForUser(req.user._id);
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
    minSweep: env.minSweepMinutes,
    showNew: extra.showNew ?? false,
    error: extra.error || null,
    notice: extra.notice || null,
    values: extra.values || {},
    tprFor, rel,
    sourceLabel: (id) => getSource(id)?.label || id,
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

    // Checkboxes arrive as a string when one is ticked, an array when
    // several are. Normalise, then keep only sources we actually have —
    // a hand-crafted POST must not be able to name an arbitrary adapter.
    const rawSources = [].concat(req.body.sources ?? []).map((v) => str(v, { max: 24 }));
    // Keep only sources that exist AND cover the chosen country. The form
    // hides the inapplicable ones, but a hidden checkbox is not a rule —
    // without this a hand-written POST could attach a Sri Lankan board to
    // a watch for Germany and quietly sweep it forever for nobody.
    const chosen = [...new Set(rawSources)]
      .filter((id) => getSource(id) && sourceCoversCountry(id, geoId));
    const sources = chosen.length ? chosen : [DEFAULT_SOURCE];
    const every = int(req.body.every, { min: env.minSweepMinutes, max: 60, fallback: 5 });
    // Deliberately opt-in. A keyword can only ever be matched against a
    // job TITLE, and employers routinely tag a job "Internship" while
    // calling it "Real Estate Sales Agent" — that one shows in a
    // logged-in search for "intern" and no title filter on earth finds
    // it. This is the only setting that catches those.
    const matchAll = req.body.matchAll === "on" || req.body.matchAll === "1";
    const values = { label, keywords: str(req.body.keywords, { max: 600 }), geoId, every, sources, matchAll };

    if (!label)
      return render(req, res, { showNew: true, values, error: "Give it a name so you can tell watches apart." });
    if (!kw.length && !matchAll)
      return render(req, res, { showNew: true, values, error: "At least one keyword — or tick “every job in the country” below." });
    if (!isKnownGeo(geoId))
      return render(req, res, { showNew: true, values, error: "Pick a country from the list." });

    const geo = findGeo(geoId);
    const query = await Queries.upsert({
      // matchAll changes WHICH jobs a query yields, so two watches that
      // differ only by it must not share a row.
      keywordsKey: canonicalKey(kw, sources) + (matchAll ? "@@all" : ""),
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
    if (!id) return res.redirect("/watches");
    const list = await Subs.listForUser(req.user._id);
    const current = list.find((s) => String(s._id) === String(id));
    if (current) await Subs.setActive(req.user._id, id, !current.active);
    res.redirect("/watches");
  } catch (err) {
    next(err);
  }
});

watchesRoutes.post("/watches/:id/delete", requireAuth, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (id) await Subs.remove(req.user._id, id);
    res.redirect("/watches");
  } catch (err) {
    next(err);
  }
});
