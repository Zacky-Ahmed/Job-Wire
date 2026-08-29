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
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";
import { collections } from "../../config/db.js";

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

export function stopPoller() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  // A slow sweep must not stack: skip this tick rather than overlap.
  if (running || stopped) return;
  running = true;
  const tickStarted = Date.now();
  try {
    await beat({ lastTickAt: new Date(), state: "working" });
    // Deliver anything that failed last time before looking for more.
    // A caught job the user never received is worth more than a new one.
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
    }
  } catch (err) {
    log.error("tick failed", { message: err.message });
  } finally {
    running = false;
    await beat({
      state: "idle",
      currentQueryId: null,
      lastTickMs: Date.now() - tickStarted,
    });
  }
}

/** Used by the "sweep now" control and by scripts. */
export async function sweepOnce(query) {
  return sweepQuery(query);
}
