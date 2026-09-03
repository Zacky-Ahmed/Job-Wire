// alertedJobs.js
//
// Every job this search has EVER been shown, whether or not it was mailed.
//
// The name is historical: this began as a record of what had been emailed.
// That was not enough, and the difference cost real inboxes.
//
// seenJobs is the wire's memory and expires after SEEN_JOB_TTL_DAYS so the
// feed stays a feed. Dedupe used to run against it, which meant a posting a
// board left up for longer than that window silently fell out of the set,
// came back on the next sweep looking brand new, and was alerted all over
// again. On 2026-09-03 at 15:30 that rediscovered 22 MAS listings at once —
// 18 of them more than a fortnight old, one printed 170 days old — and sent
// each to five people. It was not a one-off either: every long-lived listing
// would have done it again fourteen days later, for ever.
//
// Recording only what was SENT could not stop it, because those jobs had
// never been sent: the old day-precision rule had suppressed them by date,
// and removing that rule is what let them through.
//
// So the ledger remembers everything the sweep has laid eyes on. It holds
// ids and nothing else, so it stays a fraction of seenJobs even over years,
// and it is the single answer to "is this actually new?" — which is the only
// question dedupe was ever asking. Age stops standing in for novelty: a
// listing printed 56 days old that we have genuinely never seen is news, and
// one printed today that we saw last month is not.

import { collections } from "../config/db.js";

/** Which of these has this search already met? */
export async function knownIds(queryId, jobIds) {
  if (!jobIds.length) return new Set();
  const rows = await collections.alertedJobs()
    .find({ queryId, jobId: { $in: jobIds } }, { projection: { jobId: 1 } })
    .toArray();
  return new Set(rows.map((r) => r.jobId));
}

/**
 * Claim these ids, and return only the ones this call actually won.
 *
 * The unique index is the concurrency guard: two sweeps racing the same
 * job both try to insert, one loses with a duplicate key, and only the
 * winner is allowed to alert. Unordered so a single collision does not
 * abandon the rest of the batch.
 */
export async function remember(queryId, jobIds) {
  if (!jobIds.length) return new Set();
  const at = new Date();
  const docs = jobIds.map((jobId) => ({ queryId, jobId, seenAt: at }));
  try {
    await collections.alertedJobs().insertMany(docs, { ordered: false });
    return new Set(jobIds);
  } catch (err) {
    const writeErrors = err?.writeErrors || [];
    if (err?.code !== 11000 && !writeErrors.length) throw err;
    if (writeErrors.some((e) => e.err?.code !== 11000)) throw err;
    const lost = new Set(writeErrors.map((e) => docs[e.index]?.jobId));
    return new Set(jobIds.filter((id) => !lost.has(id)));
  }
}

/** Used when a query is deleted, so its ledger goes with it. */
export function forgetQuery(queryId) {
  return collections.alertedJobs().deleteMany({ queryId });
}
