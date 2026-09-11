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
//   watch    put somebody ON a search — the mirror of unwatch, and the
//            answer to "can you just add me to that one": a shared query
//            already sweeping costs nothing to add a person to
//   unwatch  drop ONE person's watch — the support case is a bounced
//            address or a watch somebody asks to be taken off by mail,
//            neither of which they can do without signing in
//   merge    fold one search into another, moving its watchers across
//   filter   narrow what ONE watcher is emailed, without changing what
//            the search fetches or what anybody else receives
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
import { log } from "../utils/logger.js";
import { headerState } from "../utils/header.js";
import * as Subs from "../models/subscriptions.js";
import * as EmailLog from "../models/emailLog.js";
import { rel } from "../utils/time.js";
import { listPacks, getPack } from "../services/packs.js";
import * as Ledger from "../models/alertedJobs.js";
import * as Outbox from "../models/outbox.js";
import { dailyCap, providerLabel } from "../services/mail/transport.js";
import { env } from "../config/env.js";

export const adminRoutes = Router();

/**
 * What the page says about the action you just took.
 *
 * Refusals and confirmations travel as query flags rather than session
 * state, so a redirect can explain itself instead of silently doing
 * nothing. Lifted out of the page render because a mutation answered
 * over htmx never gets to that redirect — it has to produce the same
 * sentence itself, and two copies of these sentences would drift.
 */
function adminFlash(q = {}) {
  return {
    adminError: q.err === "self"  ? "You cannot delete the account you are signed in with." :
        q.err === "admin" ? "That account is an admin. Remove it from ADMIN_EMAILS first." :
        q.err === "inuse" ? "Someone still watches that search. Remove their watch first, or park it instead." :
        // Emitted by the park guard since the day it was added, and
        // mapped nowhere — so the refusal it exists to explain looked
        // exactly like a dead button.
        q.err === "watched" ? "Someone is actively watching that search, so parking it would stop their alerts. Ask them to pause the watch first." :
        q.err === "selfmerge" ? "A search cannot be merged into itself." :
        q.err === "geo" ? "Those two searches are in different countries. Merging them would change which region every watcher is following." :
        q.err === "already" ? "That account already watches this search." :
        q.err === "nosuch" ? "That account or search no longer exists." : null,
    adminNotice: q.swept ? "Sweep started. It runs in the background — reload in a minute to see the result." :
        q.unwatched ? "Watch removed. If that was the last one on the search, it has stopped sweeping." :
        q.watched ? `${q.watched} now watches that search. A shared query is one fetch however many people are on it, so this costs nothing.` :
        q.filtered ? `Email filter set to ${q.filtered}. Their wire still shows everything the watch catches — only the email is narrowed.` :
        // Both halves are worth saying: "moved" is who came across,
        // "dropped" is who was already on the target and would otherwise
        // have been sent two copies of every job.
        q.merged !== undefined
          ? `Merged. ${q.merged} watch(es) moved across` +
            (Number(q.dropped) ? `, ${q.dropped} duplicate watch(es) removed` : "") +
            ". The old search is parked — delete it when the move looks right."
          : null,
  };
}

/**
 * Answer a mutation.
 *
 * Without script this is the redirect it has always been. Over htmx it
 * is 204 and a list of what changed: the panels that care are listening
 * for those names and fetch themselves, so parking a query re-renders
 * two panels instead of the whole page, and the four other panels — plus
 * the shell — are not touched.
 *
 * The flash rides along as an event rather than a query flag, because
 * there is no navigation left to carry a query flag on.
 */
function answer(req, res, to, events = []) {
  if (req.get("hx-request") !== "true") return res.redirect(to);
  const flash = adminFlash(Object.fromEntries(new URLSearchParams(to.split("?")[1] || "")));
  const trigger = {};
  for (const e of events) trigger[e] = true;
  if (flash.adminError || flash.adminNotice) {
    /* Percent-encoded, because an HTTP header is bytes and these
       sentences are not. The first one tried carried an em dash and the
       response died with "Invalid character in header content" — which
       reads as a server fault rather than as a punctuation mark. */
    trigger["jw:flash"] = {
      text: encodeURIComponent(flash.adminError || flash.adminNotice),
      bad: !!flash.adminError,
    };
  }
  res.set("HX-Trigger", JSON.stringify(trigger));
  return res.status(204).end();
}

/**
 * Everything the admin page shows, gathered once.
 *
 * Pulled out of the route so a single section can be re-rendered on its
 * own. The alternative — a handler per panel, each with its own reads —
 * is four more places for the People cap, the "today" boundary or the
 * poller verdict to be computed slightly differently, and those
 * disagreements are exactly the bugs this page keeps having.
 *
 * It over-fetches for a fragment: asking for the Delivery panel still
 * counts users. That is deliberate. The reads are one parallel round
 * trip and the page is for one operator, so paying for the whole set
 * buys the guarantee that no two panels can ever disagree.
 */
async function adminData(req, res) {
    /* The People list is capped, and the cap is a DISPLAY limit only.
       Every total is counted in the database instead of measured off the
       array, because deriving them from a truncated list means the
       headline count silently freezes at the cap and never says so. The
       page also states what it is showing out of what exists, so a
       missing account reads as "not on this page" rather than "gone". */
    const PEOPLE_LIMIT = 200;

    /* Everything that depends on nothing goes in one round trip.
       
       Measured before this change: the parallel block below took 169ms and
       was then followed by four more queries in series — my-watches,
       last-send, poller and the watcher lookup — for another ~250ms of a
       467ms page. Three of those four depend on nothing at all and were
       serial only because they were written further down the function.
       Rendering the whole page, for comparison, is 4ms. */
    const [
      userCount, verifiedCount, users, queries, watches, mailToday, failedToday,
      myWatches, lastSend, beat, watcherUsers,
    ] = await Promise.all([
        collections.users().countDocuments({}),
        collections.users().countDocuments({ verified: true }),
        collections.users()
          .find({}, { projection: { passHash: 0, otpHash: 0 } })
          .sort({ createdAt: -1 })
          .limit(PEOPLE_LIMIT)
          .toArray(),
        collections.queries().find({}).sort({ createdAt: -1 }).toArray(),
        collections.subscriptions().find({}).toArray(),
        /* Calendar day, not a rolling 24 hours. The cap this is divided
           by is enforced by the poller against countToday(), so a rolling
           window put a number on screen that decided nothing: it could
           read 260/280 while today's actual spend was 40, or sit
           comfortably low on the morning the sends were about to stop. */
        EmailLog.countToday(),
        EmailLog.countFailedToday(),
        // Independent of every query above; only their position made them wait.
        Subs.listForUser(req.user._id),
        collections.emailLog()
          .find({ status: "sent" }).sort({ sentAt: -1 }).limit(1).next(),
        collections.pollerState().findOne({ _id: "poller" }),
        /* The addresses of everyone who watches anything, resolved by the
           database rather than by a second trip from here.
           
           This used to read the subscriptions first and then look their
           accounts up with an $in, which cannot start until the first has
           landed — 63ms of a page that was already waiting on the block
           above. Grouping to distinct watchers and joining inside one
           aggregate makes it depend on nothing, so it runs alongside
           everything else. It is bounded by the number of distinct people
           watching, not by the size of the users collection. */
        collections.subscriptions().aggregate([
          { $group: { _id: "$userId" } },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
          { $unwind: "$u" },
          { $project: { _id: 1, email: "$u.email" } },
        ]).toArray(),
      ]);
    res.locals.t?.mark("db-core");

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
    /* Looked up from the subscriptions themselves, not from the People
       array above. Reading them off a list capped at PEOPLE_LIMIT meant
       every watcher whose account fell outside the newest N rendered as
       "(deleted account)" — a label an owner could reasonably act on by
       deleting a search real people were waiting on. */
    const emailById = new Map(watcherUsers.map((u) => [String(u._id), u.email]));
    const subsByQuery = new Map();
    for (const s of watches) {
      const k = String(s.queryId);
      if (!subsByQuery.has(k)) subsByQuery.set(k, []);
      subsByQuery.get(k).push({
        id: String(s._id),
        // Which narrowing this person has, if any. Query-level state is
        // shared; this is the one thing on the row that is theirs alone.
        pack: s.emailPack || "",
        email: emailById.get(String(s.userId)) || "(deleted account)",
        label: s.label,
        active: s.active !== false,
      });
    }

    res.locals.t?.mark("shape-index");
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

    /* Which rows are the SAME SEARCH written two ways.
       Grouped here rather than eyeballed, because the duplicates that
       actually cost something never look alike: "intern",
       "intern@@linkedin" and "intern@@keells+linkedin" read as three
       different searches and issued three identical fetches. */
    const identityGroups = new Map();
    for (const q of queries) {
      const k = q.identityKey || Queries.identityOf(q);
      if (!identityGroups.has(k)) identityGroups.set(k, []);
      identityGroups.get(k).push(q);
    }

    res.locals.t?.mark("shape-people");
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
        // True when another row fetches exactly the same thing. Shown as
        // a badge so it is visible without reading every key on the page.
        duplicate: (identityGroups.get(q.identityKey || Queries.identityOf(q)) || []).length > 1,
        /* Where this search could be folded. Same country only: sources
           are derived from the country and a search fetches that
           country's pages, so merging across one would hand every
           watcher a region they did not ask for. Within a country it is
           a judgement call, which is the whole reason it is a manual
           button and not something the system does behind the admin. */
        /* Everybody not already on this search.
           
           Built from the People array, which is capped at PEOPLE_LIMIT —
           so on an instance with more accounts than that the picker shows
           the newest of them rather than everyone. Stated here because a
           name missing from a dropdown is otherwise indistinguishable
           from a name that does not exist. */
        addable: people
          .filter((u) => !watchers.some((w) => w.email === u.email))
          .map((u) => ({ id: u.id, email: u.email, verified: u.verified })),
        mergeTargets: queries
          .filter((o) => String(o._id) !== qid && o.geoId === q.geoId)
          .map((o) => ({
            id: String(o._id),
            label: (o.keywords || []).join(", ") || "everything",
            same: (o.identityKey || Queries.identityOf(o)) ===
                  (q.identityKey || Queries.identityOf(q)),
            watchers: (subsByQuery.get(String(o._id)) || []).length,
          }))
          .sort((a, b) => Number(b.same) - Number(a.same) || b.watchers - a.watchers),
      };
    });

    res.locals.t?.mark("shape-query-rows");

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


    const delivery = {
      provider: providerLabel(),
      from,
      relayed,
      misaligned: relayed && freemail.test(from),
      lastSentAt: lastSend ? rel(lastSend.sentAt) : "never",
    };

    /* Liveness, measured. "Poller: Running" was computed from
       POLLER_ENABLED and a count of active watches — configuration, not
       evidence. A loop that threw on startup or wedged mid-sweep still
       reported Running. The heartbeat the loop writes each tick makes
       staleness observable. */
    /* A sweep walks every page of every source plus a detail request per
       new job, and a tick does up to ten of them in a row. Fifteen
       minutes on ONE query is not slow, it is wedged. */
    const STALL_MINUTES = 15;


    const tickAgeMs = beat?.lastTickAt ? Date.now() - new Date(beat.lastTickAt) : null;
    const state = beat?.state || "unknown";
    const never = !beat?.lastTickAt;

    /* lastTickAt is stamped when a tick STARTS, so judging staleness on
       it alone declared the poller dead in the middle of a long pass —
       ten queries at a couple of minutes each is twenty times the old
       90-second threshold. Harmless while it was one line in a panel;
       not harmless now that the headline tile reads the same verdict.
       A working tick is therefore measured from whichever is newer, the
       tick's start or the query it most recently claimed: the first
       covers the retry phase before any query is claimed, the second
       covers the sweeps after it. Only an idle poller is judged on
       missed ticks, where three in a row is not a blip. */
    const progressAt = Math.max(
      beat?.currentSince ? new Date(beat.currentSince).getTime() : 0,
      beat?.lastTickAt ? new Date(beat.lastTickAt).getTime() : 0
    );
    const stale = never ? false
      : state === "working"
        ? Date.now() - progressAt > STALL_MINUTES * 60000
        : tickAgeMs > env.pollTickSeconds * 3000;

    const poller = {
      configured: env.pollerEnabled,
      lastTickAt: beat?.lastTickAt || null,
      tickAgeSec: tickAgeMs == null ? null : Math.round(tickAgeMs / 1000),
      stale,
      never,
      state,
      sweeping: state === "working" && !stale,
      queueDepth: beat?.queueDepth ?? null,
      lastTickMs: beat?.lastTickMs ?? null,
    };

    /* Computed once, here, because the tile and the panel disagreeing on
       the same page load is the defect: the tile printed POLLER_ENABLED
       and said "Running" while the panel underneath it, reading the
       heartbeat, said "Not ticking". Configuration is not evidence, and
       the two must never be able to contradict each other again. */
    poller.alive = poller.configured && !poller.never && !poller.stale;
    poller.label =
      !poller.configured ? "Off" :
      poller.never       ? "No tick" :
      poller.stale       ? "Stalled" :
      poller.sweeping    ? "Sweeping" : "Alive";
    poller.tone = !poller.configured ? "amber" : poller.alive ? "go" : "sig";
    poller.detail =
      !poller.configured ? "POLLER_ENABLED is false" :
      poller.never       ? "no heartbeat recorded yet" :
      poller.stale       ? `no progress for ${Math.round((Date.now() - progressAt) / 60000)} min` :
      poller.sweeping    ? `working · ${poller.queueDepth ?? 0} queued` :
                           `ticked ${poller.tickAgeSec}s ago`;

    /* sourceHealth is written on every sweep but was never displayed, so
       a board could be failing for weeks while the query showed healthy —
       exactly the gap it was added to close.

       The reducer that closed it then opened a quieter version of the
       same gap in the other direction. The ok flag was STICKY: one
       failure, in one query, at any point in the recorded history
       pinned a board red permanently, while the timestamp beside it
       went on advancing to the newest entry. A board that failed once
       and had answered every sweep since read "Failing" next to a fresh
       time — and an owner who sees that twice learns to ignore the
       panel, which costs more than not having it, because the real
       outage looks identical.

       Each query holds a complete snapshot overwritten on every sweep,
       so the newest entry across every query IS the last result. That
       is the verdict. How WIDELY a board is failing is a different
       question and a useful one, so it is counted separately rather
       than folded in: "failing in 3 of 7 searches" separates a board
       that is down from one query asking it something it dislikes. The
       age travels with it, because the newest entry can still be days
       old if nothing has swept since. */
    const bySource = new Map();
    for (const q of queries) {
      for (const h of q.sourceHealth || []) {
        let row = bySource.get(h.source);
        if (!row) {
          row = { source: h.source, ok: true, error: null, at: null, failing: 0, total: 0 };
          bySource.set(h.source, row);
        }
        row.total++;
        if (!h.ok) row.failing++;
        // Newest wins, and it carries its own verdict with it. Taking
        // the flag from one entry and the time from another is exactly
        // what produced a red pill beside a fresh timestamp.
        if (row.at == null || (h.at && new Date(h.at) > new Date(row.at))) {
          row.at = h.at || null;
          row.ok = !!h.ok;
          row.error = h.error || null;
        }
      }
    }
    // Failing boards first: the panel is read to find them.
    const sourceHealth = [...bySource.values()]
      .sort((a, b) => Number(a.ok) - Number(b.ok) || a.source.localeCompare(b.source))
      .map((r) => ({ ...r, seen: r.at ? rel(r.at) : "never" }));
    res.locals.t?.mark("shape-health");

    return {
      title: "Admin",
      nav: "admin",
      user: req.user,
      isAdmin: true,
      ...headerState(myWatches, env.pollerEnabled),
      people,
      queryRows,
      packs: listPacks(),
      delivery,
      poller,
      sourceHealth,
      ...adminFlash(req.query),
      totals: {
        users: userCount,
        verified: verifiedCount,
        unverified: userCount - verifiedCount,
        shown: people.length,
        limit: PEOPLE_LIMIT,
        watches: watches.length,
        queries: queries.length,
        mailToday,
        failedToday,
        mailCap: dailyCap(),
        mailProvider: providerLabel(),
      },
    };
}

adminRoutes.get("/admin", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    page(res, "pages/admin", await adminData(req, res));
  } catch (err) {
    next(err);
  }
});

/**
 * One panel, on its own.
 *
 * Admin mutations used to answer with a redirect, which after the shell
 * became persistent meant the most write-heavy page in the app was also
 * the only one still rebuilding itself from scratch on every click. Now
 * a mutation says WHAT changed and the panels that care come and get it.
 *
 * The section name is checked against a fixed list rather than passed
 * through to a template path — a route that renders whatever view name
 * arrives in the URL is a file read waiting to be pointed somewhere
 * else.
 */
const ADMIN_SECTIONS = new Set(["overview", "health", "delivery", "people", "queries"]);

adminRoutes.get("/admin/fragments/:section", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const section = String(req.params.section || "");
    if (!ADMIN_SECTIONS.has(section)) return res.status(404).type("text/plain").send("Not found");
    const data = await adminData(req, res);
    res.render("partials/admin/" + section, data, (err, html) => {
      if (err) return next(err);
      res.type("text/html").send(html);
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
    if (!id) return answer(req, res, "/admin", ["admin:peopleChanged"]);
    const u = await collections.users().findOne({ _id: id }, { projection: { email: 1, verified: 1 } });
    if (u && !u.verified) {
      await collections.users().updateOne(
        { _id: id },
        { $set: { verified: true, verifiedAt: new Date() },
          $unset: { otpHash: "", otpExpiresAt: "", otpAttempts: "" } }
      );
      log.warn("ADMIN verified an account by hand", { by: req.user.email, account: u.email });
    }
    return answer(req, res, "/admin", ["admin:peopleChanged"]);
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
    if (!id) return answer(req, res, "/admin", ["admin:peopleChanged", "admin:queriesChanged"]);
    const u = await collections.users().findOne({ _id: id }, { projection: { email: 1 } });
    if (!u) return answer(req, res, "/admin", ["admin:peopleChanged", "admin:queriesChanged"]);

    // Two refusals, both about not being able to undo it from here.
    if (String(id) === String(req.user._id)) {
      log.warn("ADMIN tried to delete their own account", { by: req.user.email });
      return answer(req, res, "/admin?err=self", ["admin:peopleChanged", "admin:queriesChanged"]);
    }
    if (isAdmin(u)) {
      log.warn("ADMIN tried to delete another admin", { by: req.user.email, account: u.email });
      return answer(req, res, "/admin?err=admin", ["admin:peopleChanged", "admin:queriesChanged"]);
    }

    const subs = await collections.subscriptions().find({ userId: id }).toArray();
    /* CANCEL WHAT THEY ARE STILL OWED, FIRST.

       An outbox row carries its own copy of the address so a retry does
       not depend on the user row still being there — which means
       deleting the account does NOT stop the mail. This route deleted
       subscriptions directly rather than going through Subs.remove(),
       so it skipped the cancellation that path does, and a closed
       account could still be emailed about jobs found before it closed.

       Before the deletes, not after: if this throws, the account still
       exists and can be deleted again. Deleting first and failing here
       would leave obligations pointing at a user nobody can look up. */
    await Promise.all(subs.map((sub) => Outbox.forgetSubscription(sub._id)));

    /* Three deletes across three collections that do not depend on each
       other, so they go together instead of one after another. */
    await Promise.all([
      collections.subscriptions().deleteMany({ userId: id }),
      collections.emailLog().deleteMany({ userId: id }),
      collections.users().deleteOne({ _id: id }),
    ]);
    /* Every search this person watched has to be re-timed now that a
       subscriber is gone. Distinct queries only, and all at once. */
    const touched = new Map();
    for (const s of subs) touched.set(String(s.queryId), s.queryId);
    await Promise.all([...touched.values()].map((qid) => Subs.syncSchedule(qid)));
    log.warn("ADMIN deleted an account", { by: req.user.email, account: u.email, watches: subs.length });
    return answer(req, res, "/admin", ["admin:peopleChanged", "admin:queriesChanged"]);
  } catch (err) { next(err); }
});

/** Park a query nobody needs, or wake one to look at it. */
adminRoutes.post("/admin/queries/:id/toggle", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return answer(req, res, "/admin", ["admin:queriesChanged", "admin:pollerChanged"]);
    const q = await collections.queries().findOne({ _id: id }, { projection: { nextFetchAt: 1, location: 1 } });
    if (q) {
      /* Parking is only ever safe for a query nobody is listening to.
         The toggle enforced nothing, so one click could silently stop
         every alert for real subscribers — and because syncSchedule only
         re-runs when a subscription changes, it stayed stopped until
         someone happened to pause or resume a watch. Waking is always
         allowed; it is the direction that cannot hurt anyone. */
      const parking = q.nextFetchAt != null;
      if (parking) {
        const live = await collections.subscriptions()
          .countDocuments({ queryId: id, active: true });
        if (live > 0) {
          log.warn("ADMIN tried to park a query people are watching", {
            by: req.user.email, location: q.location, activeWatchers: live,
          });
          return answer(req, res, "/admin?err=watched", ["admin:queriesChanged", "admin:pollerChanged"]);
        }
      }
      await Queries.setSweeping(id, q.nextFetchAt == null);
      log.warn("ADMIN " + (q.nextFetchAt == null ? "resumed" : "parked") + " a query",
        { by: req.user.email, location: q.location });
    }
    return answer(req, res, "/admin", ["admin:queriesChanged", "admin:pollerChanged"]);
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
    if (!id) return answer(req, res, "/admin", ["admin:pollerChanged", "admin:deliveryChanged"]);
    const q = await collections.queries().findOne({ _id: id });
    if (q) {
      /* Make the poller pick it up rather than sweeping it here. Calling
         sweepQuery directly ran it alongside whatever the poller was
         already doing, which breaks the one-request-at-a-time property
         the whole scraping approach depends on — two concurrent sweeps
         look exactly like the traffic a board blocks you for. Setting
         nextFetchAt to now means the next tick claims it, in order. */
      /* failCount has to be cleared with it. The loop parks any due
         query that has reached maxFailCount BEFORE it ever attempts a
         fetch, and the only place that counter resets is reschedule(),
         which runs after a successful sweep. So on the one kind of query
         an owner actually presses this button for — a failing one — the
         request was accepted, the query was re-parked for 24 hours on
         the next tick, and the page said "Sweep started." Clearing it
         here is the same reasoning setSweeping() already applies when
         resuming a parked query by hand. */
      log.warn("ADMIN queued an immediate sweep", {
        by: req.user.email, location: q.location, clearedFails: q.failCount || 0,
      });
      await collections.queries().updateOne(
        { _id: id },
        { $set: { nextFetchAt: new Date(), failCount: 0 } }
      );
    }
    return answer(req, res, "/admin?swept=1", ["admin:pollerChanged", "admin:deliveryChanged"]);
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
    if (!id) return answer(req, res, "/admin", ["admin:queriesChanged"]);
    const q = await collections.queries().findOne({ _id: id });
    if (!q) return answer(req, res, "/admin", ["admin:queriesChanged"]);

    const subs = await collections.subscriptions().countDocuments({ queryId: id });
    const force = req.body.force === "1";

    if (subs > 0 && !force) {
      log.warn("ADMIN tried to delete a query someone still watches",
        { by: req.user.email, location: q.location, subscribers: subs });
      return answer(req, res, "/admin?err=inuse", ["admin:queriesChanged"]);
    }

    /* Forced deletion takes the watches WITH it, and that is the whole
       reason the refusal existed rather than timidity: a subscription is
       joined to its query, so removing the query and leaving the rows
       behind makes each watch disappear from its owner's page with no
       message and no way to restore it — present in the database, absent
       from every screen. Deleting them is at least honest, and the person
       can create the watch again.
       
       The button is only offered with a confirmation naming how many
       watches it destroys, because nothing else on this page can take
       something away from somebody who did not ask. */
    if (subs > 0) {
      const rows = await collections.subscriptions().find({ queryId: id }).toArray();
      /* One query for every address, not one per subscription.
         
         This read the users collection inside the loop, so a search with
         twenty watchers cost twenty round trips — about 65ms each here —
         to build a log line. The distinct ids go in a single $in. */
      const ids = [...new Set(rows.map((r) => String(r.userId)))]
        .map((k) => rows.find((r) => String(r.userId) === k).userId);
      const who = ids.length
        ? (await collections.users()
            .find({ _id: { $in: ids } }, { projection: { email: 1 } })
            .toArray()).map((u) => u.email)
        : [];
      // Same rule as everywhere else: a watch that no longer exists
      // cannot be owed anything. Cancelled before the rows go.
      await Promise.all(rows.map((r) => Outbox.forgetSubscription(r._id)));
      await collections.subscriptions().deleteMany({ queryId: id });
      log.warn("ADMIN force-deleted a search that people were watching", {
        by: req.user.email, location: q.location,
        keywords: (q.keywords || []).join("+") || "everything",
        watchesDestroyed: rows.length, accounts: who.join(", "),
      });
    }

    const jobs = await collections.seenJobs().countDocuments({ queryId: id });
    await collections.seenJobs().deleteMany({ queryId: id });
    // The ledger as well. It is keyed by (queryId, jobId) and outlives the
    // wire by years, so leaving it behind would keep ids claimed against a
    // search that no longer exists — invisible, and never expiring on any
    // clock a reader can see.
    await Ledger.forgetQuery(id);
    /* And anything the outbox still promised on its behalf. A pending
       obligation against a deleted search would be delivered by the next
       worker pass, describing a watch nobody has any more. */
    await Outbox.forgetQuery(id);
    await collections.queries().deleteOne({ _id: id });
    log.warn("ADMIN deleted a query", {
      by: req.user.email, location: q.location,
      keywords: (q.keywords || []).join("+") || "everything", jobsDropped: jobs,
    });
    return answer(req, res, "/admin", ["admin:queriesChanged"]);
  } catch (err) { next(err); }
});


/**
 * Remove ONE person's watch.
 *
 * The account survives; only the subscription goes. This is the shape
 * every support request about watches has actually had — an address that
 * keeps bouncing, or somebody asking by mail to be taken off a search
 * they cannot sign in to remove themselves. Deleting the whole account
 * for that is a bigger hammer than the situation deserves, and deleting
 * the query is refused outright while anyone is on it.
 *
 * syncSchedule afterwards is the point of doing it here rather than in
 * the database by hand: if that was the last active watcher, the search
 * stops sweeping in the same breath instead of running on for nobody.
 */
adminRoutes.post("/admin/watches/:id/delete", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return answer(req, res, "/admin", ["admin:queriesChanged"]);
    const sub = await collections.subscriptions().findOne({ _id: id });
    if (!sub) return answer(req, res, "/admin", ["admin:queriesChanged"]);
    const u = await collections.users().findOne(
      { _id: sub.userId }, { projection: { email: 1 } });

    await Outbox.forgetSubscription(id);
    await collections.subscriptions().deleteOne({ _id: id });
    await Subs.syncSchedule(sub.queryId);

    log.warn("ADMIN removed somebody's watch", {
      by: req.user.email, account: u?.email || String(sub.userId), watch: sub.label,
    });
    return answer(req, res, "/admin?unwatched=1", ["admin:queriesChanged"]);
  } catch (err) { next(err); }
});

/**
 * Fold one search into another, taking its watchers with it.
 *
 * The manual counterpart to what upsert() now does on its own. New
 * watches join an existing search by identityKey, so fresh duplicates
 * cannot appear — but rows created under the old scheme are already
 * split, and no amount of correctness at the front door merges those.
 * This is the door for them, and for the judgement calls the system
 * should not be making by itself: "internship" and "intern" are not the
 * same string and a person has to decide they are the same search.
 *
 * Nobody loses a watch. Subscriptions are repointed at the target, and
 * where that would give one person the same watch twice the redundant
 * row is dropped rather than the search — with the watch left switched
 * on if either copy was on, since the surprise worth avoiding is alerts
 * going quiet, not an extra one arriving.
 *
 * seenJobs stay with their own query and are not copied across. The wire
 * scopes every watch to its own createdAt, so a repointed watcher sees
 * what the target found from now on, which is what they were getting
 * anyway — the two rows were fetching the same jobs.
 *
 * The source is parked, not deleted, so the merge can be looked at
 * before anything is destroyed. Deleting it afterwards is the existing
 * button, which already refuses while a subscriber remains.
 */
adminRoutes.post("/admin/queries/:id/merge", ...guard, async (req, res, next) => {
  try {
    const from = oid(req.params.id);
    const into = oid(req.body.into);
    if (!from || !into) return answer(req, res, "/admin", ["admin:queriesChanged"]);
    if (String(from) === String(into)) return answer(req, res, "/admin?err=selfmerge", ["admin:queriesChanged"]);

    const [src, dst] = await Promise.all([
      collections.queries().findOne({ _id: from }),
      collections.queries().findOne({ _id: into }),
    ]);
    if (!src || !dst) return answer(req, res, "/admin", ["admin:queriesChanged"]);

    /* Refused across countries, and this is not caution for its own
       sake: sources are chosen by country and each search fetches that
       country's pages, so merging Sri Lanka into Germany would silently
       swap every watcher's region for one they never asked for. */
    if (src.geoId !== dst.geoId) {
      log.warn("ADMIN tried to merge across countries", {
        by: req.user.email, from: src.location, into: dst.location,
      });
      return answer(req, res, "/admin?err=geo", ["admin:queriesChanged"]);
    }

    const subs = await collections.subscriptions().find({ queryId: from }).toArray();
    let moved = 0, dropped = 0;
    for (const sub of subs) {
      // Re-checked per subscription: two rows belonging to the same
      // person both look movable until the first one lands.
      const existing = await collections.subscriptions().findOne({
        userId: sub.userId, queryId: into,
      });
      if (existing) {
        if (sub.active && !existing.active) {
          await collections.subscriptions().updateOne(
            { _id: existing._id }, { $set: { active: true } });
        }
        /* Dropping a duplicate watch takes its unsent obligations with
           it. The survivor's own rows still stand, so the person is told
           once rather than twice — which is the entire point of merging
           two searches that were always the same search. */
        await Outbox.forgetSubscription(sub._id);
        await collections.subscriptions().deleteOne({ _id: sub._id });
        dropped++;
      } else {
        await collections.subscriptions().updateOne(
          { _id: sub._id }, { $set: { queryId: into } });
        moved++;
      }
    }

    await Subs.syncSchedule(from);
    await Subs.syncSchedule(into);

    log.warn("ADMIN merged two searches", {
      by: req.user.email,
      from: (src.keywords || []).join("+") || "everything",
      into: (dst.keywords || []).join("+") || "everything",
      location: src.location, moved, dropped,
    });
    return answer(req, res, `/admin?merged=${moved}&dropped=${dropped}`, ["admin:queriesChanged"]);
  } catch (err) { next(err); }
});


/**
 * Put somebody on a search that already exists.
 *
 * The mirror of the unwatch button, and the reason it earns a place: a
 * shared query is one fetch however many people are on it, so adding
 * somebody to a search that is already sweeping costs nothing at all. The
 * support case is "can you just add me to the intern one" from a person
 * who would otherwise re-type the same keywords and — before identityKey
 * existed — split the query in two doing it.
 *
 * Unverified accounts are allowed on purpose. fanOut refuses to mail an
 * address that has not confirmed itself, so the watch simply sits there
 * until they verify, which is better than refusing the request and better
 * than pretending it was actioned.
 */
adminRoutes.post("/admin/queries/:id/watchers", ...guard, async (req, res, next) => {
  try {
    const queryId = oid(req.params.id);
    const userId = oid(req.body.userId);
    if (!queryId || !userId) return answer(req, res, "/admin", ["admin:queriesChanged"]);

    const [q, u] = await Promise.all([
      collections.queries().findOne({ _id: queryId }),
      collections.users().findOne({ _id: userId }, { projection: { email: 1, verified: 1 } }),
    ]);
    if (!q || !u) return answer(req, res, "/admin?err=nosuch", ["admin:queriesChanged"]);

    const label = (q.keywords || []).join(", ") || q.location || "Watch";
    // Inherits the search's current cadence; see the note in starterWatch.js
    // about why a silent subscriber is worse than an agreeing one.
    const sub = await Subs.create({
      userId, queryId, label, requestedEveryMinutes: q.everyMinutes,
    });
    if (!sub) {
      // The unique index caught it: they are already on this search.
      return answer(req, res, "/admin?err=already", ["admin:queriesChanged"]);
    }

    log.warn("ADMIN added somebody to a search", {
      by: req.user.email, account: u.email,
      search: (q.keywords || []).join("+") || "everything",
      location: q.location, unverified: !u.verified || undefined,
    });
    return answer(req, res, `/admin?watched=${encodeURIComponent(u.email)}`, ["admin:queriesChanged"]);
  } catch (err) { next(err); }
});


/**
 * Narrow what one watcher is emailed.
 *
 * The search is untouched: same query, same sweep, same jobs remembered,
 * and everyone else on it keeps receiving everything. Only the last step
 * — which of the batch is handed to this person — changes, which is why a
 * pack can be set and cleared freely with nothing to migrate either way.
 *
 * Their wire is deliberately NOT filtered. The point is a quieter inbox,
 * not a shorter page.
 */
adminRoutes.post("/admin/watches/:id/pack", ...guard, async (req, res, next) => {
  try {
    const id = oid(req.params.id);
    if (!id) return answer(req, res, "/admin", ["admin:queriesChanged"]);
    const asked = String(req.body.pack || "").trim();
    // Validated against the registry: an unknown id would sit in the
    // database looking like a filter and silently do nothing.
    const packId = getPack(asked) ? asked : "";

    const sub = await Subs.setEmailPack(id, packId);
    if (!sub) return answer(req, res, "/admin?err=nosuch", ["admin:queriesChanged"]);
    const u = await collections.users().findOne(
      { _id: sub.userId }, { projection: { email: 1 } });

    log.warn("ADMIN changed a watcher's email filter", {
      by: req.user.email, account: u?.email || String(sub.userId),
      pack: packId || "(none)",
    });
    return answer(req, res, `/admin?filtered=${encodeURIComponent(packId ? getPack(packId).label : "off")}`, ["admin:queriesChanged"]);
  } catch (err) { next(err); }
});
