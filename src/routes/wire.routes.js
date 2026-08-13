// wire.routes.js
//
// The dispatch feed: every job caught for the queries this user watches,
// newest first. /wire/rows is the fragment HTMX re-polls.

import { Router } from "express";
import { page } from "../utils/render.js";
import { requireAuth } from "../middleware/requireAuth.js";
import * as Subs from "../models/subscriptions.js";
import * as SeenJobs from "../models/seenJobs.js";
import * as EmailLog from "../models/emailLog.js";
import { rel, minutesSince } from "../utils/time.js";
import { env } from "../config/env.js";

export const wireRoutes = Router();
wireRoutes.use(requireAuth);

const WINDOW_MIN = 60; // assumed application window — an estimate, labelled as one

async function gather(user) {
  const watches = await Subs.listForUser(user._id);
  const labelByQuery = new Map(watches.map((w) => [String(w.queryId), w.label]));
  const queryIds = watches.map((w) => w.queryId);

  const caught = queryIds.length ? await SeenJobs.recentForQueries(queryIds, 50) : [];
  const emails = await EmailLog.recentForUser(user._id, 30);

  // A job is only a "dispatch" if it arrived after its query was primed,
  // i.e. it was actually emailed. Everything else was memorised silently.
  const emailedIds = new Set(emails.flatMap((e) => e.jobIds || []));

  const dispatches = caught.map((j) => {
    const age = minutesSince(j.firstSeenAt);
    const pct = Math.min(100, Math.round((age / WINDOW_MIN) * 100));
    return {
      ...j,
      label: labelByQuery.get(String(j.queryId)) || "deleted watch",
      ageText: rel(j.firstSeenAt),
      emailed: emailedIds.has(j.jobId),
      windowPct: pct,
      windowLeft: Math.max(0, WINDOW_MIN - age),
      windowClass: pct > 75 ? "h" : pct > 45 ? "w" : "",
    };
  });

  return {
    watches,
    watchCount: watches.length,
    activeCount: watches.filter((w) => w.active).length,
    dispatches,
    emailCount: emails.filter((e) => e.status === "sent").length,
    sentToday: await EmailLog.countToday(),
    pollerEnabled: env.pollerEnabled,
  };
}

wireRoutes.get("/", (req, res) => res.redirect("/wire"));

wireRoutes.get("/wire", async (req, res, next) => {
  try {
    const data = await gather(req.user);
    page(res, "pages/wire", { title: "The Wire", nav: "wire", user: req.user, ...data });
  } catch (err) {
    next(err);
  }
});

// HTMX polls this every 15s — fragment only, no layout.
wireRoutes.get("/wire/rows", async (req, res, next) => {
  try {
    const { dispatches } = await gather(req.user);
    res.render("partials/wire-rows", { dispatches }, (err, html) => {
      if (err) return next(err);
      res.type("text/html").send(html);
    });
  } catch (err) {
    next(err);
  }
});
