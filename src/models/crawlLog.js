// crawlLog.js
//
// What one surface walk did, page by page, with the clock attached.
//
// This exists to answer one question that nothing in the system could
// previously answer: a watch is set to five minutes, a job arrives
// twenty minutes after it is visible on linkedin.com — WHOSE twenty
// minutes is it?
//
// There are four clocks in that gap and only two are ours:
//
//   the employer posts it                          not ours
//   LinkedIn's PUBLIC surfaces start exposing it   not ours
//   our crawl reaches the page it is on            OURS
//   matched, queued, sent                          OURS
//
// Without the timestamps to separate them, the only available move is to
// crawl more often — which costs requests against a lag that may never
// have been ours, on the one source that answers being hammered by going
// quiet. So: measure first, and be able to say "the guest surface had it
// at 10:07 and we did not reach it until 10:22" or "no public surface
// had it until 10:24", because those have opposite fixes.
//
// BOUNDED, because a per-page log is the easiest unbounded collection in
// the world to write by accident. One document per surface walk, not one
// per page — the pages are an array inside it — and a short TTL. Seven
// days is enough to investigate a complaint from last week and not
// enough to become a storage problem.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

export const CRAWL_LOG_TTL_DAYS = 7;

/** One surface walk. */
export async function record({
  sweepId, queryId, source, surface, geoId,
  scheduledFor, startedAt, finishedAt,
  pages, stopReason, ok, error,
}) {
  try {
    await collections.crawlLog().insertOne({
      sweepId, queryId, source, surface, geoId,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      startedAt: new Date(startedAt),
      finishedAt: new Date(finishedAt),
      /* Queue delay and service time, stored rather than derived, so a
         query over a week of these does not have to recompute them. */
      queueDelayMs: scheduledFor ? Math.max(0, startedAt - new Date(scheduledFor).getTime()) : null,
      serviceMs: finishedAt - startedAt,
      requests: pages.length,
      /* Per page: when we asked, how long it took, and WHICH JOBS came
         back. The job ids are the point — "which page was it on, and
         when did we reach that page" is the question this collection
         exists for, and it cannot be reconstructed later. */
      pages: pages.map((p) => ({
        page: p.page,
        atMs: p.atMs,            // ms into this walk
        ms: p.ms,
        returned: p.returned ?? 0,
        fresh: p.fresh ?? 0,
        jobIds: p.jobIds || [],
        error: p.error || null,
      })),
      stopReason,
      ok: ok !== false,
      error: error || null,
      at: new Date(),
    });
  } catch (err) {
    // Diagnostics must never fail the crawl they are describing.
    log.warn("could not record a crawl log", { source, surface, message: err.message });
  }
}

/**
 * Every walk that saw a given job, oldest first.
 *
 * The answer to "when did our surfaces first have this?" — which,
 * compared against when the reader saw it on linkedin.com, is what
 * separates our delay from LinkedIn's.
 */
export function walksThatSaw(jobId, { limit = 50 } = {}) {
  return collections.crawlLog()
    .find({ "pages.jobIds": jobId })
    .sort({ startedAt: 1 })
    .limit(limit)
    .toArray();
}

/** Recent walks of one surface, for the admin health view. */
export function recentWalks({ source = "linkedin", surface = null, limit = 50 } = {}) {
  const q = { source };
  if (surface) q.surface = surface;
  return collections.crawlLog()
    .find(q, { projection: { pages: 0 } })   // the timeline, not every page
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Where a sweep's time actually went, per surface, over a window.
 *
 * Measured on 2026-09-11 against the live board, walking every surface
 * to its real end: the country feed took 67-75s over 23-24 requests, the
 * guest keyword surface 13-19s over 4-6, and JSERP 96-134s over 25-40
 * — of which everything past page 2-4 returned nothing new at all.
 */
export async function surfaceCost({ source = "linkedin", days = 1 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  return collections.crawlLog().aggregate([
    { $match: { source, startedAt: { $gte: since } } },
    { $group: {
      _id: "$surface",
      walks: { $sum: 1 },
      requests: { $sum: "$requests" },
      totalMs: { $sum: "$serviceMs" },
      avgMs: { $avg: "$serviceMs" },
      avgQueueDelayMs: { $avg: "$queueDelayMs" },
    } },
    { $sort: { totalMs: -1 } },
  ]).toArray();
}
