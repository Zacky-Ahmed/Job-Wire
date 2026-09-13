// pollerWorkers.js
//
// One runtime row PER WORKER, keyed by that worker's own id.
//
// There was one row, `pollerState._id = "poller"`, and every process
// wrote to it. That is fine with one process and quietly corrupt with
// two, which a rolling deploy guarantees:
//
//   A holds the lease and is crawling LinkedIn, page 18
//   B boots, cannot take the lease, writes state:"standby"
//   A's noteProgress() writes currentPage/currentSource — but not state
//
// leaving a single row that says:
//
//   state         standby
//   currentSource linkedin
//   currentPage   18
//   lastProgress  3 seconds ago
//
// which describes no process that exists. And because the UI was just
// unified onto one snapshot, all four surfaces would now agree on it
// beautifully — a worse failure than the disagreement it replaced,
// because nothing looks wrong.
//
// So each worker owns its own document and writes only there. Authority
// lives in pollerLease; the lease names an owner, and that owner's row
// is the truth. A standby worker may heartbeat all day without touching
// the crawler's state.
//
//   pollerLease.owner  ->  pollerWorkers[owner]  ->  authoritative state

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

/* Long enough that a worker which stopped writing is genuinely gone,
   short enough that a dead row does not linger for hours. Rows expire
   on their own so a retired instance does not need cleaning up. */
export const WORKER_TTL_MINUTES = 30;

/**
 * Write this worker's runtime. Never anybody else's.
 *
 * The owner is part of the filter, not just the payload, so a bug that
 * passes the wrong id creates a new row rather than overwriting a
 * living worker's state.
 */
export async function beat(owner, patch) {
  if (!owner) return;
  try {
    await collections.pollerWorkers().updateOne(
      { _id: owner },
      { $set: { ...patch, owner, at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    // Never let bookkeeping stop the sweep it is describing.
    log.warn("worker heartbeat write failed", { owner, message: err.message });
  }
}

/** The row belonging to whoever currently holds the lease. */
export function forOwner(owner) {
  if (!owner) return Promise.resolve(null);
  return collections.pollerWorkers().findOne({ _id: owner });
}

/** Everything alive, for an admin view of a multi-process deployment. */
export function all({ limit = 20 } = {}) {
  return collections.pollerWorkers()
    .find({}, { projection: { _id: 1, owner: 1, state: 1, at: 1, currentSource: 1, currentPage: 1, lastProgressAt: 1 } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}

/** On a clean shutdown, so the row does not linger pretending to work. */
export async function retire(owner) {
  if (!owner) return;
  try {
    await collections.pollerWorkers().updateOne(
      { _id: owner },
      { $set: { state: "stopped", at: new Date(), stoppedAt: new Date() } }
    );
  } catch { /* the TTL will take it */ }
}
