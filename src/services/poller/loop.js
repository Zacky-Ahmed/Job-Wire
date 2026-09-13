// loop.js
//
// The forever loop. This is the product; everything else exists to feed it.
//
// Queries are swept ONE AT A TIME, not in parallel. Ten simultaneous
// requests from one IP is what a scraper looks like; a steady trickle is
// what a browser looks like.

import * as Queries from "../../models/queries.js";
import { sweepQuery } from "./sweep.js";
import { retryFailedSends } from "./retry.js";
import { drainOutbox } from "../mail/outboxWorker.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";
import { collections } from "../../config/db.js";
import * as Lease from "../../models/pollerLease.js";
import * as Workers from "../../models/pollerWorkers.js";
import { reportUtilisation } from "./utilisation.js";
import { selectNext, utilisation } from "./schedule.js";
import { openPass, closePass } from "./snapshot.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/* A heartbeat the loop writes itself.
 *
 * The admin page reported "Poller: Running" from POLLER_ENABLED and a
 * count of active watches — configuration, not liveness. If the loop
 * threw on startup, or the interval died, or the process was wedged, the
 * page went on saying Running while nothing swept. That is the same
 * silent-shortfall shape as every other bug in this project: it reports
 * success and quietly does less.
 *
 * Written on every tick, so staleness is measurable: if lastTickAt is
 * older than a few tick intervals, the loop is not running whatever the
 * config says.
 */
async function beat(patch) {
  try {
    /* THIS WORKER'S ROW, not the shared one.

       Every process used to write _id:"poller". With two processes —
       which a rolling deploy guarantees — a standby worker's
       state:"standby" landed in the same document the crawling worker
       was using, and noteProgress() then updated its page and source
       without restoring the state. The row ended up describing no
       process that existed, and since the UI had just been unified onto
       one snapshot, every surface would have agreed on it. */
    await Workers.beat(OWNER, patch);

    /* The legacy shared row is still written so anything reading it
       during a rolling deploy sees something sane. It is no longer the
       source of truth and can be dropped once no old instance is left. */
    await collections.pollerState().updateOne(
      { _id: "poller" },
      { $set: { ...patch, at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    // Never let bookkeeping stop the sweep it is describing.
    log.warn("heartbeat write failed", { message: err.message });
  }
}

let timer = null;
let running = false;
let stopped = false;

/* Who this process is, for the lease.

   Host plus pid plus a random suffix: two containers on one host share a
   hostname, two processes in one container could in principle share a
   pid namespace, and neither is worth relying on when a UUID settles it.
   Regenerated on every start, deliberately — a restarted process is a
   different holder and should not be able to renew the lease its dead
   predecessor was holding. */
const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/* The tick currently in flight, so shutdown can wait for it rather than
   killing a sweep halfway through. Null when idle. */
let inFlight = null;

/* The lease this process currently holds, with its fencing token. Held
   at module scope so shutdown can hand it back — and released
   CONDITIONALLY on the token, so a process that already lost the lease
   cannot take the crawl away from whoever legitimately took over. */
let currentFence = null;

export function pollerOwner() { return OWNER; }

/**
 * Something completed. Called from inside a crawl so a long sweep can
 * be told apart from a stuck one.
 *
 * Throttled to once every ten seconds, because a beat per HTTP request
 * is 28 writes per LinkedIn sweep to say something that only changes
 * the answer once. Staleness is judged in minutes; ten-second
 * resolution is far more than enough.
 */
let lastProgressWrite = 0;
export async function noteProgress(where = {}) {
  const now = Date.now();
  if (now - lastProgressWrite < 10_000) return;
  lastProgressWrite = now;
  await beat({
    /* state is restated, not assumed. A progress write that only set
       the page left whatever state was last written standing — which,
       on the old shared row, could be another process's "standby". */
    state: "working",
    lastProgressAt: new Date(),
    currentSource: where.source ?? null,
    currentSurface: where.surface ?? null,
    currentPage: where.page ?? null,
  });
}

export function startPoller() {
  if (timer) return;
  stopped = false;
  log.info("poller started", {
    tickSeconds: env.pollTickSeconds,
    minSweepMinutes: env.minSweepMinutes,
  });
  timer = setInterval(tick, env.pollTickSeconds * 1000);
  tick(); // do not wait a full tick for the first pass

  /* The other lane. Started here so one call still starts the poller,
     but it runs on its own clock and never awaits the crawl. */
  startDeliveryLoop();
}

/**
 * Stop scheduling, wait for the tick in flight, and hand the lease back.
 *
 * The old version set a flag and cleared the interval, which stops new
 * ticks and does nothing about the one already running — and a LinkedIn
 * sweep takes about eighty seconds, comfortably longer than the ten
 * seconds the process gave itself before calling process.exit(1). So a
 * deploy could kill a sweep mid-crawl.
 *
 * That is survivable now rather than catastrophic, because the outbox
 * means a half-finished sweep loses at most the work it had not written
 * down yet, and everything it HAD written is still owed. But waiting is
 * cheap and losing a crawl is not, so wait — and release the lease, so
 * the replacement process starts immediately instead of sitting out the
 * five-minute TTL.
 */
export async function stopPoller({ waitMs = 90_000 } = {}) {
  stopped = true;
  /* Delivery first: it is quick, and stopping it means the drain in the
     shutdown handler is the only thing still sending. */
  if (!await stopDeliveryLoop()) return false;
  if (timer) clearInterval(timer);
  timer = null;

  let finished = true;
  if (inFlight) {
    log.info("waiting for the sweep in flight before shutting the poller down");
    const raced = await Promise.race([
      inFlight.then(() => "finished"),
      new Promise((r) => setTimeout(() => r("timed out"), waitMs)),
    ]);
    finished = raced === "finished";
    log.info("poller tick " + raced);
  }

  /* A PROCESS MUST NOT HAND OVER CRAWLING AUTHORITY WHILE IT IS STILL
     CRAWLING.

     This released the lease unconditionally after the wait — including
     when the wait TIMED OUT, which is exactly the case where the old
     process still has a LinkedIn request in the air. The replacement
     would take the freed lease and start its own crawl beside it: two
     crawlers on one IP range, which is the precise thing fencing exists
     to prevent, arriving at the worst possible moment.

     If the sweep did not finish, the lease is left to expire on its own.
     That costs the replacement up to one TTL of waiting — and waiting is
     the correct behaviour when the alternative is crawling alongside a
     process you cannot see. */
  if (!finished) {
    log.warn("shutdown timed out with a sweep still running — NOT releasing the lease", {
      note: "the replacement waits out the TTL rather than crawling beside an in-flight request",
      ttlMs: Lease.LEASE_MS,
    });
    await Workers.retire(OWNER);
    return false;
  }

  try {
    if (currentFence && await Lease.release(currentFence)) log.info("poller lease released");
  } catch (err) {
    // Not worth blocking a shutdown for; the TTL will clear it.
    log.warn("could not release the poller lease", { message: err.message });
  }
  await Workers.retire(OWNER);
  return true;
}

/* ── THE DELIVERY LANE ────────────────────────────────────────
 *
 * Mail used to run inside the crawl tick: drain, then legacy retry,
 * then crawl, then drain again after every query. Discovery and
 * delivery share no external resource — one talks to job boards, the
 * other to Brevo — but a slow provider or a large backlog still
 * delayed the next LinkedIn observation, and a long crawl still sat on
 * alerts that were already written down and ready to go.
 *
 * The outbox decoupled them in the database a week ago and left them
 * welded together in the runtime. This is the other half.
 *
 * Two loops, same process, neither awaiting the other. The outbox is
 * the only thing between them, which is exactly what it was built to
 * be.
 *
 * NO LEASE. Delivery is safe to run in more than one process: the
 * outbox claim is a findOneAndUpdate, so two workers cannot take the
 * same row, and the sealed batch and idempotency key mean a duplicate
 * attempt cannot become a duplicate email. The crawl needs a lease
 * because LinkedIn counts requests per IP; Brevo counts messages, and
 * the outbox already counts those.
 */
let deliveryTimer = null;
let delivering = false;

export function startDeliveryLoop() {
  if (deliveryTimer) return;
  log.info("delivery loop started", { everySeconds: env.deliveryTickSeconds });
  const run = async () => {
    if (delivering || stopped) return;
    delivering = true;
    const startedAt = Date.now();
    try {
      await drainOutbox();
      // The old failed-send queue, still draining emailLog rows written
      // before the outbox existed. Removed once none are left.
      await retryFailedSends();
    } catch (err) {
      /* A delivery failure must never stop the lane. The obligations
         are durable; the next pass finds them. */
      log.error("delivery pass failed", { message: err.message });
    } finally {
      delivering = false;
      const ms = Date.now() - startedAt;
      if (ms > 5000) log.info("slow delivery pass", { ms });
    }
  };
  deliveryTimer = setInterval(run, env.deliveryTickSeconds * 1000);
  run();
}

export async function stopDeliveryLoop({ waitMs = 30_000 } = {}) {
  if (deliveryTimer) clearInterval(deliveryTimer);
  deliveryTimer = null;
  const until = Date.now() + waitMs;
  while (delivering && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !delivering;
}

export function stopPollerSync() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  // A slow sweep must not stack: skip this tick rather than overlap.
  if (running || stopped) return;

  /* And it must not stack ACROSS PROCESSES either.

     `running` above is a module-level boolean, which guards one process
     and says nothing about a second. A rolling deploy alone is enough to
     have two: the old instance is still alive while the new one boots,
     and both would start crawling LinkedIn on the same schedule for the
     same queries from the same IP range. LinkedIn's answer to that is to
     stop answering, and the symptom is the one this project keeps
     having — no jobs, no error, indistinguishable from a quiet day. */
  let fence = await Lease.acquire(OWNER);
  currentFence = fence;
  if (!fence) {
    const holder = await Lease.current();
    log.info("another process holds the poller lease — standing by", {
      holder: holder?.owner, expiresAt: holder?.expiresAt,
    });
    /* Stamps lastTickAt even though no crawling happens.

       It did not, and so a standby process's tick age grew without
       bound and the admin page declared it "Stalled — no progress for
       2 min" after ninety seconds. Standby is a CORRECT state: another
       process holds the lease and this one is deliberately not
       crawling. It still has to prove it is alive, which is what the
       heartbeat is for. */
    await beat({
      state: "standby",
      lastTickAt: new Date(),
      leaseHolder: holder?.owner ?? null,
      leaseExpiresAt: holder?.expiresAt ?? null,
    });
    return;
  }

  /* RENEW WHILE WORKING, and stop the moment renewal fails.

     The lease used to be taken once here and never touched again, with a
     five-minute TTL — while a tick sweeping ten queries at 78-92 seconds
     each runs thirteen to fifteen minutes. It expired around query four
     and a second process took it, so both crawled: exactly the thing the
     lease exists to prevent, roughly two thirds of the way through every
     busy tick.

     Renewal is conditional on the fencing token, so a process that has
     been taken over cannot renew its way back in. holdsLease going false
     is not a warning to log past — it means another process is
     authoritative and this one must start no further network work. */
  let holdsLease = true;
  const renewal = setInterval(async () => {
    if (!holdsLease) return;
    try {
      const renewed = await Lease.renew(fence);
      if (renewed) { fence = renewed; currentFence = renewed; }
      else { holdsLease = false; currentFence = null; }
    } catch (err) {
      /* A failed renewal is not proof of loss — Mongo may simply have
         blinked — so it is not treated as one. The TTL is three times
         the renewal interval precisely so two of these can happen
         harmlessly before the lease actually lapses. */
      log.warn("could not renew the poller lease — will try again", { message: err.message });
    }
  }, Lease.RENEW_EVERY_MS);
  renewal.unref();

  running = true;
  const tickStarted = Date.now();
  let settle;
  inFlight = new Promise((resolve) => { settle = resolve; });

  /* A pass. Every board shared across searches is fetched at most once
     inside it, however long it runs.

     This is the unit that replaced a four-minute wall-clock TTL. The two
     agreed only while a pass finished inside four minutes, and it will
     not — LinkedIn alone is about eighty seconds a search, so the pass
     outgrows the window at roughly three searches and the sharing
     quietly stops working exactly as scale makes it matter. */
  const passId = openPass();
  try {
    await beat({ lastTickAt: new Date(), state: "working" });

    /* MEASURE WHAT THE MAIL WORK COSTS THE CRAWLER.

       Discovery and delivery are decoupled in the data model — the
       outbox saw to that — but they still run in one serial tick, and
       the crawl cannot start until the mail work above it finishes. A
       slow provider or a large backlog therefore delays the next
       LinkedIn observation even though they use entirely different
       external resources.

       That is a real coupling and the obvious fix is two independent
       lanes. But "obvious" is how this project has repeatedly optimised
       the wrong thing, so measure it first: if mail work costs
       milliseconds, moving it buys nothing and adds a second scheduler
       to reason about. */
    /* MAIL NO LONGER RUNS HERE. See startDeliveryLoop below.

       Measured first, as promised: the drain and the legacy retry ran
       before the crawl and again after every query, so a slow provider
       or a large backlog delayed the next LinkedIn observation even
       though mail and LinkedIn share no resource at all. The outbox
       decoupled them in the database and left them welded together in
       the runtime.

       They are separate loops now. Neither awaits the other. */
    const mailDrainMs = 0;

    const legacyStart = Date.now();
    // Moved to the delivery loop with the rest of the mail work.
    const legacyRetryMs = Date.now() - legacyStart;

    /* HOW MANY WERE ACTUALLY DUE, not just how many we took.

       findDue(10) is a snapshot capped at ten. With ten LinkedIn
       searches at ~81s each, a pass runs 13 minutes, and an eleventh
       due query is not even considered until it finishes — a
       five-minute cadence becoming a fifteen-minute gap with LinkedIn
       doing nothing wrong. Recording both numbers is what will show
       whether that is happening before anything is restructured. */
    /* NOT A FROZEN LIST. findDue(10) took ten due queries once and then
       walked them; with LinkedIn at 78-92 seconds that is thirteen
       minutes during which the list is stale, so a query becoming due
       at minute two waited until minute thirteen. A five-minute watch
       quietly became a fifteen-minute one.

       The pool is re-read after every sweep and schedule.js picks one
       from the CURRENT state. See the fairness rule there. */
    const dueTotal = await Queries.countDue();
    const due = await Queries.findDue(50);

    const blockedMs = mailDrainMs + legacyRetryMs;
    if (blockedMs > 2000) {
      log.warn("mail work delayed the start of this crawl", {
        mailDrainMs, legacyRetryMs, dueQueries: dueTotal,
        note: "discovery and delivery share one serial tick; this is the cost of that",
      });
    }
    await beat({
      queueDepth: due.length, dueTotal,
      lastMailDrainMs: mailDrainMs, lastLegacyRetryMs: legacyRetryMs,
      lastCrawlBlockedMs: blockedMs,
    });
    if (dueTotal > due.length) {
      log.warn("more searches are due than this pass will take", {
        due: dueTotal, taking: due.length,
        note: "the rest wait for the whole pass to finish, however long it runs",
      });
    }
    if (!due.length) return;

    log.debug("tick", { due: due.length });
    /* SELECT ONE, SWEEP IT, SELECT AGAIN — against the current state.

       The pool is re-read from the database after every sweep, so a
       query that becomes due while another is crawling is eligible the
       moment that crawl ends rather than at the end of a thirteen-minute
       walk. schedule.js decides which one; the fairness rule and the
       starvation guard live there.

       The budget bounds one pass so the tick eventually yields — it is
       not a target, and an oversubscribed lane simply means the next
       tick picks up where this one left off. */
    const PASS_BUDGET = 10;
    let sweptThisPass = 0;
    const skip = new Set();

    while (sweptThisPass < PASS_BUDGET) {
      if (stopped) break;

      /* Fresh every iteration. Reading it once would be the frozen list
         again, wearing a different shape. */
      const pool = sweptThisPass === 0 ? due : await Queries.findDue(50);
      const pick = selectNext(pool, Date.now(), { exclude: skip });
      if (!pick) break;
      const query = pick.query;

      if (pick.reason === "starving") {
        log.warn("a search waited long enough to jump the queue", {
          queryId: String(query._id),
          keywords: (query.keywords || []).join("+") || "everything",
          overdueMs: pick.overdueMs,
          note: "the starvation guard fired — the lane is behind",
        });
      }
      /* ASSERTED AGAINST MONGO, not read off a local boolean.

         This checked `holdsLease`, which is process memory updated by a
         renewal timer that deliberately treats a FAILED renewal as
         inconclusive — a Mongo blip should not surrender the crawl. The
         gap: if renewals keep throwing for longer than the TTL, the
         lease genuinely expires, another process takes it, and this one
         still believes holdsLease === true because it never received a
         definitive answer. It would then start another fetch.

         So the invariant is made literal. A renewal that comes back null
         means the database has given the lease to somebody else, and
         this process stops. No valid {owner, token} match, no network
         work. */
      const stillOurs = await Lease.renew(fence).catch((err) => {
        /* Unreachable database is not proof of loss, but it is not
           permission either. Refusing to fetch is the safe reading:
           worst case a crawl is delayed by one tick. */
        log.warn("could not confirm the poller lease before a query — not fetching", {
          message: err.message,
        });
        return null;
      });
      if (!stillOurs) {
        holdsLease = false;
        currentFence = null;
        log.error("stopping mid-tick — this process no longer holds the poller lease", {
          owner: OWNER, swept: sweptThisPass,
        });
        break;
      }
      fence = stillOurs;
      currentFence = stillOurs;
      if ((query.failCount || 0) >= env.maxFailCount) {
        /* Park it, and arm ONE probe for when the wait is over.

           The park used to leave failCount at the threshold, so the next
           time round this branch fired again and parked it for another
           day — for ever. A source outage that lasted an afternoon
           killed the search that met it, and nothing would have brought
           it back.

           Each successive park waits longer, so a source that is
           genuinely gone is not probed hourly, while one that was merely
           having a bad afternoon recovers on its own. */
        const parks = (query.parkedForMinutes || 0) >= 24 * 60 ? 2 : 1;
        const wait = Math.min(24 * 60 * parks, 72 * 60);
        log.warn("query parked after repeated failures — one probe when the wait is over", {
          queryId: String(query._id), failCount: query.failCount, waitMinutes: wait,
        });
        // Push it far out rather than deleting — a human can inspect it.
        // park(), not recordFailure(): the latter increments failCount,
        // so merely skipping a parked query made it look worse each tick.
        await Queries.park(query._id, wait, { probeAt: env.maxFailCount });
        skip.add(String(query._id));
        continue;
      }
      try {
        await beat({ currentQueryId: String(query._id), currentSince: new Date() });
        await sweepQuery(query, { queuePosition: sweptThisPass + 1, dueTotal });
      } catch (err) {
        log.error("sweep threw", { queryId: String(query._id), message: err.message });
        await Queries.recordFailure(query._id, query.everyMinutes * 2);
        /* Not reselected inside this pass. recordFailure pushes its
           deadline out, but a query whose sweep threw instantly could
           otherwise still read as the most overdue and be chosen again
           and again inside one tick. */
        skip.add(String(query._id));
      }
      /* No mail here either. The delivery loop is already sending what
         this sweep just queued, in parallel, without the crawl waiting
         on a provider it has nothing to do with. */
      sweptThisPass++;
    }
  } catch (err) {
    log.error("tick failed", { message: err.message });
  } finally {
    clearInterval(renewal);
    running = false;
    if (!holdsLease) currentFence = null;
    /* Closing the pass is what lets the NEXT one fetch fresh listings.
       Held open, a long pass would keep serving jobs from whenever it
       started; released on a timer instead, a long pass would refetch
       mid-crawl. Neither is what "one fetch per cycle" ever meant. */
    const pass = closePass();
    if (pass && pass.snapshots) {
      log.debug("pass closed", { pass: passId, ...pass });
    }
    /* Is the schedule everyone asked for still possible?

       U = Σ(serviceTime / interval) over the searches sharing the
       LinkedIn lane. Above 1 the cadence is not slow, it is impossible:
       sweeps fall further behind every cycle for ever, and the only
       symptom anybody sees is alerts arriving later and later for no
       stated reason. Computed from measured crawl times rather than
       assumed ones, and reported here because nothing else looks at the
       whole schedule at once. */
    let utilisation = null;
    try {
      utilisation = await reportUtilisation();
    } catch (err) {
      log.warn("could not compute lane utilisation", { message: err.message });
    }
    await beat({
      state: "idle",
      currentQueryId: null,
      lastTickMs: Date.now() - tickStarted,
      /* The HOLDER, reported as telemetry — never written to the lease
         itself. The heartbeat used to write leaseOwner into the same row
         the lease lived in, so a process that had lost the lease stamped
         its name back over the winner's at the end of its tick. */
      leaseHolder: holdsLease ? OWNER : null,
      ...(utilisation ? {
        laneUtilisation: utilisation.U,
        laneMeasured: utilisation.measured,
        laneHeadroom: utilisation.headroom,
      } : {}),
    });
    settle();
    inFlight = null;
  }
}

/** Used by the "sweep now" control and by scripts. */
export async function sweepOnce(query) {
  return sweepQuery(query);
}
