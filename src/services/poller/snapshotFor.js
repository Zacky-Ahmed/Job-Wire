// snapshotFor.js
//
// The one place a page asks "what is the poller doing?"
//
// Every surface that renders poller status reads this, so the shell chip
// and the admin card cannot describe different pollers. They could, and
// did: a screenshot showed "Sweeping" in the top bar, "Stalled" on the
// summary card, "standby" on the detail row and "Not ticking" on a badge
// — four labels, four definitions, one poller.
//
// Cached for a few seconds because every authenticated page render asks,
// and the answer changes on the poller's clock rather than the reader's.
// Two documents per page load to draw one chip is not a trade worth
// making; two documents every five seconds is.

import { collections } from "../../config/db.js";
import { env } from "../../config/env.js";
import { pollerRuntime } from "./runtime.js";
import { log } from "../../utils/logger.js";

const CACHE_MS = 5000;
let cached = null;
let cachedAt = 0;

export async function pollerSnapshot() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;

  try {
    const [beat, lease] = await Promise.all([
      collections.pollerState().findOne({ _id: "poller" }),
      collections.pollerLease().findOne({ _id: "poller.lease" }),
    ]);
    cached = pollerRuntime(beat, lease, { enabled: env.pollerEnabled });
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    /* A status widget must never take a page down. Reported as unknown,
       which renders as "unknown" rather than as a cheerful default —
       claiming health we cannot observe is the whole family of bug this
       file exists to end. */
    log.warn("could not read the poller snapshot", { message: err.message });
    return pollerRuntime(null, null, { enabled: env.pollerEnabled });
  }
}

/** Forces the next read to hit the database. For tests. */
export function clearSnapshotCache() {
  cached = null;
  cachedAt = 0;
}
