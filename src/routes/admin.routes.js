// admin.routes.js
//
// The owner's view of the whole instance: who signed up, what they watch,
// and whether the machinery behind it is actually working.
//
// It answers questions by looking, and it can act on the small set of
// things only an owner can fix. The actions are deliberately narrow:
// each one exists because a real support situation needs it and the user
// cannot do it themselves.
//
//   verify   a code landed in spam, so the account is locked out of
//            itself — this is the reason deliverability work started
//   delete   a spam signup, or someone asking to be removed
//   park     a query nobody needs, still spending requests
//   sweep    check a source is alive without waiting for the schedule
//
// What it deliberately cannot do: change anyone's password, read anyone's
// mail, or promote an admin. Admin comes from the environment, so this
// page cannot grant the very access it runs on.
//
// It also never selects passHash or otpHash. Not because the template
// would print them, but because a projection is the only place that
// guarantee can be made once instead of trusted everywhere.

import { Router } from "express";
import { page } from "../utils/render.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { collections } from "../config/db.js";
import { oid } from "../utils/sanitize.js";
import { isAdmin } from "../middleware/requireAdmin.js";
import * as Queries from "../models/queries.js";
import { sweepQuery } from "../services/poller/sweep.js";
import { log } from "../utils/logger.js";
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
    // Who is on each query, not merely how many. "1 subscriber" answers
    // the wrong question: an owner looking at a search that is spending
    // requests wants to know whose it is before touching it.
    const emailById = new Map(users.map((u) => [String(u._id), u.email]));
    const subsByQuery = new Map();
    for (const s of watches) {
      const k = String(s.queryId);
      if (!subsByQuery.has(k)) subsByQuery.set(k, []);
      subsByQuery.get(k).push({
        email: emailById.get(String(s.userId)) || "(deleted account)",
        label: s.label,
        active: s.active !== false,
      });
    }

    const now = Date.now();
    const people = users.map((u) => {
      const mine = subsByUser.get(String(u._id)) || [];
      return {
        email: u.email,
        verified: !!u.verified,
        id: String(u._id),
        createdAt: u.createdAt,
        joined: rel(u.createdAt),
        watches: mine.length,
        active: mine.filter((s) => s.active).length,
        isAdmin: env.adminEmails.includes(String(u.email).toLowerCase()),
      };
    });

    const queryRows = queries.map((q) => {
      const watchers = subsByQuery.get(String(q._id)) || [];
      const subscribers = watchers.length;
      const qid = String(q._id);
      const overdueMin = q.nextFetchAt
        ? Math.round((now - new Date(q.nextFetchAt).getTime()) / 60000)
        : null;
      return {
        id: qid,
        label: (q.keywords || []).join(", ") || "everything",
        location: q.location,
        sources: (q.sources || ["linkedin"]).join(", "),
        matchAll: !!q.matchAll,
        subscribers,
        watchers,
        // Only a query nobody is on can be removed from here. Deleting one
        // out from under a live watch would leave that person a
        // subscription row pointing at nothing — listForUser inner-joins
        // on the query, so their watch would simply vanish from their page
        // with no explanation and no way to get it back.
        deletable: subscribers === 0,
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

    // WHY MAIL IS NOT ARRIVING.
    //
    // "sent" here only means the provider accepted the message. It says
    // nothing about whether a mailbox kept it. The commonest reason for
    // "0 failed" and an empty inbox is DMARC: sending AS a gmail.com
    // address THROUGH Brevo claims a domain Brevo cannot prove it owns,
    // and Gmail filters that hardest of all — including the very
    // verification codes new accounts need to sign in.
    //
    // env.js already warns about this at boot, but a line in a log at
    // startup is a line nobody reads twice.
    const from = (env.mailFrom || "").match(/<([^>]+)>/)?.[1] || env.mailFrom || "";
    const freemail = /@(gmail|googlemail|yahoo|outlook|hotmail|live|aol|icloud|proton(mail)?)\./i;
    const relayed = !!env.brevoApiKey;
    const lastSend = await collections.emailLog()
      .find({ status: "sent" }).sort({ sentAt: -1 }).limit(1).next();

    const delivery = {
      provider: providerLabel(),
      from,
      relayed,
      misaligned: relayed && freemail.test(from),
      lastSentAt: lastSend ? rel(lastSend.sentAt) : "never",
    };

    page(res, "pages/admin", {
      title: "Admin",
      nav: "admin",
      user: req.user,
      isAdmin: true,
      ...headerState(myWatches, env.pollerEnabled),
      people,
      queryRows,
      delivery,
      // Refusals come back as a query flag so the redirect can explain
      // itself rather than silently doing nothing.
      adminError:
        req.query.err === "self"  ? "You cannot delete the account you are signed in with." :
        req.query.err === "admin" ? "That account is an admin. Remove it from ADMIN_EMAILS first." :
        req.query.err === "inuse" ? "Someone still watches that search. Remove their watch first, or park it instead." : null,
      adminNotice: req.query.swept ? "Sweep started. It runs in the background — reload in a minute to see the result." : null,
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

/* Every action below is POST + CSRF + requireAdmin, and every one logs
   who did what. An admin panel that mutates accounts without a trail is
   worse than no panel: when something is wrong later, nobody can tell
   whether a person did it or the software did. */
const guard = [requireAuth, requireAdmin];

/** A code that never arrived should not lock someone out permanently. */
adminRoutes.post("/admin/users/:id/verify", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.redirect("/admin");
    const u = await collections.users().findOne({ _id: id }, { projection: { email: 1, verified: 1 } });
    if (u && !u.verified) {
      await collections.users().updateOne(
        { _id: id },
        { $set: { verified: true, verifiedAt: new Date() },
          $unset: { otpHash: "", otpExpiresAt: "", otpAttempts: "" } }
      );
      log.warn("ADMIN verified an account by hand", { by: req.user.email, account: u.email });
    }
    res.redirect("/admin");
  } catch (err) { next(err); }
});

/**
 * Remove an account and everything attached to it.
 *
 * Cascade order matters: subscriptions go first so the queries they held
 * open can be re-evaluated afterwards, otherwise a search stays scheduled
 * for a user who no longer exists. seenJobs are NOT deleted — they belong
 * to the shared query, not the person, and other watchers still need them
 * for deduping.
 */
adminRoutes.post("/admin/users/:id/delete", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.redirect("/admin");
    const u = await collections.users().findOne({ _id: id }, { projection: { email: 1 } });
    if (!u) return res.redirect("/admin");

    // Two refusals, both about not being able to undo it from here.
    if (String(id) === String(req.user._id)) {
      log.warn("ADMIN tried to delete their own account", { by: req.user.email });
      return res.redirect("/admin?err=self");
    }
    if (isAdmin(u)) {
      log.warn("ADMIN tried to delete another admin", { by: req.user.email, account: u.email });
      return res.redirect("/admin?err=admin");
    }

    const subs = await collections.subscriptions().find({ userId: id }).toArray();
    await collections.subscriptions().deleteMany({ userId: id });
    await collections.emailLog().deleteMany({ userId: id });
    await collections.users().deleteOne({ _id: id });
    for (const qid of new Set(subs.map((s) => String(s.queryId)))) {
      await Subs.syncSchedule(subs.find((s) => String(s.queryId) === qid).queryId);
    }
    log.warn("ADMIN deleted an account", { by: req.user.email, account: u.email, watches: subs.length });
    res.redirect("/admin");
  } catch (err) { next(err); }
});

/** Park a query nobody needs, or wake one to look at it. */
adminRoutes.post("/admin/queries/:id/toggle", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.redirect("/admin");
    const q = await collections.queries().findOne({ _id: id }, { projection: { nextFetchAt: 1, location: 1 } });
    if (q) {
      await Queries.setSweeping(id, q.nextFetchAt == null);
      log.warn("ADMIN " + (q.nextFetchAt == null ? "resumed" : "parked") + " a query",
        { by: req.user.email, location: q.location });
    }
    res.redirect("/admin");
  } catch (err) { next(err); }
});

/**
 * Sweep one query now.
 *
 * Not awaited: a sweep walks every page of every source and can take a
 * couple of minutes, which is far longer than a browser will wait. Kick
 * it off, redirect, and let the page show the result on the next load.
 */
adminRoutes.post("/admin/queries/:id/sweep", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.redirect("/admin");
    const q = await collections.queries().findOne({ _id: id });
    if (q) {
      log.warn("ADMIN forced a sweep", { by: req.user.email, location: q.location });
      sweepQuery(q).catch((e) => log.error("forced sweep failed", { message: e.message }));
    }
    res.redirect("/admin?swept=1");
  } catch (err) { next(err); }
});

/**
 * Remove a query and the jobs it remembered.
 *
 * Refused while anyone is subscribed, and that is not timidity: a
 * subscription is joined to its query, so deleting the query would make
 * the watch disappear from that person's page with no message and no way
 * to restore it. Parked and orphaned rows are what this is for — they
 * accumulate, and until now nothing could clear them.
 */
adminRoutes.post("/admin/queries/:id/delete", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.redirect("/admin");
    const q = await collections.queries().findOne({ _id: id });
    if (!q) return res.redirect("/admin");

    const subs = await collections.subscriptions().countDocuments({ queryId: id });
    if (subs > 0) {
      log.warn("ADMIN tried to delete a query someone still watches",
        { by: req.user.email, location: q.location, subscribers: subs });
      return res.redirect("/admin?err=inuse");
    }

    const jobs = await collections.seenJobs().countDocuments({ queryId: id });
    await collections.seenJobs().deleteMany({ queryId: id });
    await collections.queries().deleteOne({ _id: id });
    log.warn("ADMIN deleted a query", {
      by: req.user.email, location: q.location,
      keywords: (q.keywords || []).join("+") || "everything", jobsDropped: jobs,
    });
    res.redirect("/admin");
  } catch (err) { next(err); }
});
