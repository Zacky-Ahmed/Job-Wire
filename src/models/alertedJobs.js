// alertedJobs.js
//
// "Have we ever emailed this job to this search?"
//
// seenJobs cannot answer that. It is the wire's memory and expires after
// SEEN_JOB_TTL_DAYS so the feed stays a feed, which means a posting a
// board leaves up for longer than that window is eventually forgotten,
// rediscovered, and mailed a second time as though it were news.
//
// The old defence was to refuse day-precision jobs whose printed date was
// older than the TTL. It worked, and it also silently killed real
// listings: Keells leaves postings up for months and stamps them with the
// date they were raised, so "Intern - Supply Chain" arrived printed 56
// days old and "Technical Intern" 672 days old. Both were genuinely new
// to us, both went to the wire, and neither was ever emailed — the exact
// complaint that started this.
//
// Separating the two questions fixes it. The wire keeps a short memory of
// what it has SHOWN; this keeps a long memory of what it has SENT. Age
// then stops being a proxy for novelty, and first sight can mean what the
// sweep already believed it meant: if it is appearing now and was not
// there before, it is news, whatever date it prints.
//
// Only alerted jobs land here, so it stays a fraction of seenJobs.

import { collections } from "../config/db.js";

/** Which of these have already been emailed for this search. */
export async function alreadySent(queryId, jobIds) {
  if (!jobIds.length) return new Set();
  const rows = await collections.alertedJobs()
    .find({ queryId, jobId: { $in: jobIds } }, { projection: { jobId: 1 } })
    .toArray();
  return new Set(rows.map((r) => r.jobId));
}

/**
 * Record that these went out.
 *
 * Unordered so one duplicate key does not abandon the rest of the batch,
 * and duplicates are expected here: two sweeps can race the same job, and
 * the index is what makes that harmless.
 */
export async function markSent(queryId, jobIds) {
  if (!jobIds.length) return 0;
  const now = new Date();
  try {
    const res = await collections.alertedJobs().insertMany(
      jobIds.map((jobId) => ({ queryId, jobId, sentAt: now })),
      { ordered: false }
    );
    return res.insertedCount;
  } catch (err) {
    // 11000 is the unique index doing its job. Anything else is real.
    if (err?.code === 11000 || err?.writeErrors?.every((e) => e.err?.code === 11000)) {
      return err.result?.insertedCount ?? 0;
    }
    throw err;
  }
}

/** Used when a query is deleted, so its ledger goes with it. */
export function forgetQuery(queryId) {
  return collections.alertedJobs().deleteMany({ queryId });
}
