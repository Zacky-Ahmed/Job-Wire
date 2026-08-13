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
import { canonicalKey, tprFor } from "../services/linkedin/buildUrl.js";
import { rel, countdown } from "../utils/time.js";
import { env } from "../config/env.js";

export const watchesRoutes = Router();
watchesRoutes.use(requireAuth);

async function render(req, res, extra = {}) {
  const watches = await Subs.listForUser(req.user._id);
  const activeCount = watches.filter((w) => w.active).length;
  page(res, "pages/watches", {
    title: "Watches",
    nav: "watches",
    user: req.user,
    watches,
    watchCount: watches.length,
    activeCount,
    pollerEnabled: env.pollerEnabled,
    countries: selectableCountries(),
    minSweep: env.minSweepMinutes,
    showNew: extra.showNew ?? false,
    error: extra.error || null,
    notice: extra.notice || null,
    values: extra.values || {},
    tprFor, rel,
  });
}

watchesRoutes.get("/watches", (req, res, next) =>
  render(req, res, { showNew: req.query.new === "1" }).catch(next)
);

watchesRoutes.post("/watches", async (req, res, next) => {
  try {
    const label = str(req.body.label, { max: 80 });
    const kw = cleanKeywords(req.body.keywords);
    const geoId = str(req.body.geoId, { max: 20 });
    const every = int(req.body.every, { min: env.minSweepMinutes, max: 60, fallback: 5 });
    const values = { label, keywords: str(req.body.keywords, { max: 600 }), geoId, every };

    if (!label)
      return render(req, res, { showNew: true, values, error: "Give it a name so you can tell watches apart." });
    if (!kw.length)
      return render(req, res, { showNew: true, values, error: "At least one keyword — otherwise this matches every job in the country." });
    if (!isKnownGeo(geoId))
      return render(req, res, { showNew: true, values, error: "Pick a country from the list." });

    const geo = findGeo(geoId);
    const query = await Queries.upsert({
      keywordsKey: canonicalKey(kw),
      keywords: kw,
      geoId,
      location: geo.name,
      everyMinutes: every,
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

watchesRoutes.post("/watches/:id/toggle", async (req, res, next) => {
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

watchesRoutes.post("/watches/:id/delete", async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (id) await Subs.remove(req.user._id, id);
    res.redirect("/watches");
  } catch (err) {
    next(err);
  }
});
