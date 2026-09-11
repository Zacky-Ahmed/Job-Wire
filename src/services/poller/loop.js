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
import { reportUtilisation } from "./utilisation.js";
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

export function startPoller() {
  if (timer) return;
  stopped = false;
  log.info("poller started", {
    tickSeconds: env.pollTickSeconds,
    minSweepMinutes: env.minSweepMinutes,
  });
  timer = setInterval(tick, env.pollTickSeconds * 1000);
  tick(); // do not wait a full tick for the first pass
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
  if (timer) clearInterval(timer);
  timer = null;

  if (inFlight) {
    log.info("waiting for the sweep in flight before shutting the poller down");
    const raced = await Promise.race([
      inFlight.then(() => "finished"),
      new Promise((r) => setTimeout(() => r("timed out"), waitMs)),
    ]);
    log.info("poller tick " + raced);
  }

  try {
    if (currentFence && await Lease.release(currentFence)) log.info("poller lease released");
  } catch (err) {
    // Not worth blocking a shutdown for; the TTL will clear it.
    log.warn("could not release the poller lease", { message: err.message });
  }
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
    await beat({ state: "standby", leaseHolder: holder?.owner ?? null });
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
    const mailStart = Date.now();
    await drainOutbox();
    const mailDrainMs = Date.now() - mailStart;

    const legacyStart = Date.now();
    // The old failed-send queue, still draining emailLog rows written
    // before the outbox existed. Removed once none are left.
    await retryFailedSends();
    const legacyRetryMs = Date.now() - legacyStart;

    /* HOW MANY WERE ACTUALLY DUE, not just how many we took.

       findDue(10) is a snapshot capped at ten. With ten LinkedIn
       searches at ~81s each, a pass runs 13 minutes, and an eleventh
       due query is not even considered until it finishes — a
       five-minute cadence becoming a fifteen-minute gap with LinkedIn
       doing nothing wrong. Recording both numbers is what will show
       whether that is happening before anything is restructured. */
    const [due, dueTotal] = await Promise.all([
      Queries.findDue(10),
      Queries.countDue(),
    ]);

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
    for (const query of due) {
      if (stopped) break;
      /* Checked before EVERY query, not once per tick. This is the rule
         the whole lease exists to enforce: a worker without a valid
         fenced lease may not start another fetch. */
      if (!holdsLease) {
        log.error("stopping mid-tick — this process no longer holds the poller lease", {
          owner: OWNER, done: due.indexOf(query), of: due.length,
        });
        break;
      }
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
        continue;
      }
      try {
        await beat({ currentQueryId: String(query._id), currentSince: new Date() });
        await sweepQuery(query, {
          queuePosition: due.indexOf(query) + 1,
          dueTotal,
        });
      } catch (err) {
        log.error("sweep threw", { queryId: String(query._id), message: err.message });
        await Queries.recordFailure(query._id, query.everyMinutes * 2);
      }
      /* Again after each query, so a long crawl does not sit on the mail
         it has already earned. A ten-query tick used to mean the tenth
         query's alerts waited for the first nine to finish; obligations
         written a minute ago should not wait on a crawl that has minutes
         left to run. */
      await drainOutbox();
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
