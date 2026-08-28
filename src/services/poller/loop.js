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
  try {
    // Deliver anything that failed last time before looking for more.
    // A caught job the user never received is worth more than a new one.
    await retryFailedSends();

    const due = await Queries.findDue(10);
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
  }
}

/** Used by the "sweep now" control and by scripts. */
export async function sweepOnce(query) {
  return sweepQuery(query);
}
