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
import { headerState } from "../utils/header.js";
import { env } from "../config/env.js";
import { dailyCap, providerLabel } from "../services/mail/transport.js";

export const wireRoutes = Router();

// requireAuth is applied PER ROUTE, not with wireRoutes.use(): a
// router-level guard also intercepts unknown paths, so every 404 in the
// app was answered with a redirect to /signin.

const WINDOW_MIN = 60; // assumed application window — an estimate, labelled as one

async function gather(user) {
  const watches = await Subs.listForUser(user._id);
  const labelByQuery = new Map(watches.map((w) => [String(w.queryId), w.label]));

  // Scoped to when THIS person started watching. The query row behind a
  // watch is shared, so an unscoped read handed a new account the whole
  // history of a search other people had been running for weeks.
  const scope = watches.map((w) => ({ queryId: w.queryId, since: w.createdAt }));
  const caught = await SeenJobs.recentForSubscriptions(scope, 50);
  const emails = await EmailLog.recentForUser(user._id, 30);

  // Only SUCCESSFUL sends count as delivered. Including failed ones here
  // showed "Sent" next to jobs whose email never arrived — the single most
  // misleading thing this screen could say, because the whole product is
  // "did I get told in time".
  const emailedIds = new Set(
    emails.filter((e) => e.status === "sent").flatMap((e) => e.jobIds || [])
  );
  const failedIds = new Set(
    emails.filter((e) => e.status === "failed").flatMap((e) => e.jobIds || [])
  );

  const dispatches = caught.map((j) => {
    // The application window is about how long the JOB has been open, not
    // how long we have known about it. Using firstSeenAt made a job we
    // discovered late look freshly posted — a fifteen-hour-old listing
    // reading "~60m left" is the most misleading thing this screen can say.
    const age = minutesSince(j.postedAt || j.firstSeenAt);
    const pct = Math.min(100, Math.round((age / WINDOW_MIN) * 100));
    return {
      ...j,
      label: labelByQuery.get(String(j.queryId)) || "deleted watch",
      ageText: rel(j.firstSeenAt),
      // The row-arrival flash has a CSS rule and a class hook but nothing
      // ever set the flag, so it never once fired. A job caught since the
      // last poll of this page is what "new" means here.
      isNew: minutesSince(j.firstSeenAt) < 5,
      emailed: emailedIds.has(j.jobId),
      failed: !emailedIds.has(j.jobId) && failedIds.has(j.jobId),
      windowPct: pct,
      windowLeft: Math.max(0, WINDOW_MIN - age),
      windowClass: pct > 75 ? "h" : pct > 45 ? "w" : "",
    };
  });

  return {
    watches,
    ...headerState(watches, env.pollerEnabled),
    dispatches,
    // The COUNT, not the length of the page we happen to render. These
    // differed by 176 for this user: 226 matches, a 50-row page.
    caughtCount: await SeenJobs.countMatchedForSubscriptions(scope),
    // Yours, not the instance's. This used to be the global figure, so a
    // brand-new account with an empty inbox was told "4 emails sent
    // today" — four emails that had gone to other people.
    sentToday: await EmailLog.countTodayForUser(user._id),
    sentTodayAll: await EmailLog.countToday(),
    mailCap: dailyCap(),
    mailProvider: providerLabel(),
    pollerEnabled: env.pollerEnabled,
  };
}

wireRoutes.get("/wire", requireAuth, async (req, res, next) => {
  try {
    const data = await gather(req.user);
    page(res, "pages/wire", { title: "The Wire", nav: "wire", user: req.user, ...data });
  } catch (err) {
    next(err);
  }
});

// HTMX polls this every 15s — fragment only, no layout.
wireRoutes.get("/wire/rows", requireAuth, async (req, res, next) => {
  try {
    const { dispatches, watchCount } = await gather(req.user);
    res.render("partials/wire-rows", { dispatches, watchCount }, (err, html) => {
      if (err) return next(err);
      res.type("text/html").send(html);
    });
  } catch (err) {
    next(err);
  }
});
