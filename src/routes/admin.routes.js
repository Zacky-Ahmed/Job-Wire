// admin.routes.js
//
// The owner's view of the whole instance: who signed up, what they watch,
// and whether the machinery behind it is actually working.
//
// READ ONLY, on purpose. Every question this page answers ("did that
// signup verify?", "why did nobody get mail last night?", "is a query
// wedged?") is answerable by looking. Adding buttons that mutate other
// people's accounts would need a far more careful permission story than
// an env var, so it does not have any.
//
// It also never selects passHash or otpHash. Not because the template
// would print them, but because a projection is the only place that
// guarantee can be made once instead of trusted everywhere.

import { Router } from "express";
import { page } from "../utils/render.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { collections } from "../config/db.js";
import { headerState } from "../utils/header.js";
import * as Subs from "../models/subscriptions.js";
import { rel } from "../utils/time.js";
import { dailyCap, providerLabel } from "../services/mail/transport.js";
import { env } from "../config/env.js";

export const adminRoutes = Router();

adminRoutes.get("/admin", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);

    const [users, queries, watches, mail24, failed24] = await Promise.all([
      collections.users()
        .find({}, { projection: { passHash: 0, otpHash: 0 } })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray(),
      collections.queries().find({}).sort({ createdAt: -1 }).toArray(),
      collections.subscriptions().find({}).toArray(),
      collections.emailLog().countDocuments({ sentAt: { $gte: since }, status: "sent" }),
      collections.emailLog().countDocuments({ sentAt: { $gte: since }, status: "failed" }),
    ]);

    // One pass instead of a query per user — a page that lists accounts
    // must not issue N queries to do it.
    const subsByUser = new Map();
    for (const s of watches) {
      const k = String(s.userId);
      if (!subsByUser.has(k)) subsByUser.set(k, []);
      subsByUser.get(k).push(s);
    }
    const subsByQuery = new Map();
    for (const s of watches) {
      const k = String(s.queryId);
      subsByQuery.set(k, (subsByQuery.get(k) || 0) + 1);
    }

    const now = Date.now();
    const people = users.map((u) => {
      const mine = subsByUser.get(String(u._id)) || [];
      return {
        email: u.email,
        verified: !!u.verified,
        createdAt: u.createdAt,
        joined: rel(u.createdAt),
        watches: mine.length,
        active: mine.filter((s) => s.active).length,
        isAdmin: env.adminEmails.includes(String(u.email).toLowerCase()),
      };
    });

    const queryRows = queries.map((q) => {
      const subscribers = subsByQuery.get(String(q._id)) || 0;
      const overdueMin = q.nextFetchAt
        ? Math.round((now - new Date(q.nextFetchAt).getTime()) / 60000)
        : null;
      return {
        label: (q.keywords || []).join(", ") || "everything",
        location: q.location,
        sources: (q.sources || ["linkedin"]).join(", "),
        matchAll: !!q.matchAll,
        subscribers,
        tracked: q.trackedCount ?? 0,
        peak: q.trackedPeak ?? 0,
        every: q.everyMinutes,
        lastFetched: rel(q.lastFetchedAt),
        failCount: q.failCount || 0,
        retired: !q.nextFetchAt,
        // A query nobody watches, or one that is running far behind its
        // own schedule, is the shape every silent failure here has taken.
        orphaned: subscribers === 0 && !!q.nextFetchAt,
        stalled: overdueMin !== null && overdueMin > Math.max(15, q.everyMinutes * 3),
        overdueMin,
      };
    });

    const myWatches = await Subs.listForUser(req.user._id);

    page(res, "pages/admin", {
      title: "Admin",
      nav: "admin",
      user: req.user,
      isAdmin: true,
      ...headerState(myWatches, env.pollerEnabled),
      people,
      queryRows,
      totals: {
        users: people.length,
        verified: people.filter((p) => p.verified).length,
        unverified: people.filter((p) => !p.verified).length,
        watches: watches.length,
        queries: queries.length,
        mail24,
        failed24,
        mailCap: dailyCap(),
        mailProvider: providerLabel(),
        pollerEnabled: env.pollerEnabled,
      },
    });
  } catch (err) {
    next(err);
  }
});
