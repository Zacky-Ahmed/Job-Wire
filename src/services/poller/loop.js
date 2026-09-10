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
    if (await Lease.release(OWNER)) log.info("poller lease released");
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
  const held = await Lease.acquire(OWNER);
  if (!held) {
    const holder = await Lease.current();
    log.info("another process holds the poller lease — standing by", {
      holder: holder?.owner, expiresAt: holder?.expiresAt,
    });
    await beat({ state: "standby", leaseOwner: holder?.owner ?? null });
    return;
  }

  running = true;
  const tickStarted = Date.now();
  let settle;
  inFlight = new Promise((resolve) => { settle = resolve; });
  try {
    await beat({ lastTickAt: new Date(), state: "working" });
    /* Deliver what is already owed before looking for more.

       A caught job the reader never received is worth more than a new
       one, and now that the sweep only writes obligations, this is where
       the mail actually leaves. Draining first also means a tick that
       dies partway through the crawl has still delivered the backlog it
       started with. */
    await drainOutbox();
    // The old failed-send queue, still draining emailLog rows written
    // before the outbox existed. Removed once none are left.
    await retryFailedSends();

    const due = await Queries.findDue(10);
    await beat({ queueDepth: due.length });
    if (!due.length) return;

    log.debug("tick", { due: due.length });
    for (const query of due) {
      if (stopped) break;
      if ((query.failCount || 0) >= env.maxFailCount) {
        log.warn("query parked after repeated failures", {
          queryId: String(query._id), failCount: query.failCount,
        });
        // Push it far out rather than deleting — a human can inspect it.
        // park(), not recordFailure(): the latter increments failCount,
        // so merely skipping a parked query made it look worse each tick.
        await Queries.park(query._id, 24 * 60);
        continue;
      }
      try {
        await beat({ currentQueryId: String(query._id), currentSince: new Date() });
        await sweepQuery(query);
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
    running = false;
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
      leaseOwner: OWNER,
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
