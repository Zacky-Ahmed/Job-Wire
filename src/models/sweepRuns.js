// sweepRuns.js
//
// One row per QUERY sweep: was it selected, when did it start, and what
// did each source do.
//
// The per-surface crawl log sits below this and cannot answer the
// question above it. Given a delayed job and no LinkedIn crawl rows,
// these are all still possible:
//
//   the query was never selected by the scheduler at all;
//   it was selected but the sweep never reached LinkedIn;
//   it reached LinkedIn and LinkedIn failed before anything was logged;
//   it reached LinkedIn, LinkedIn was fine, and the job was not there.
//
// Those have four different fixes, and surface rows alone cannot
// separate them — a missing row is a missing row whichever it was.
//
// THE SKELETON IS WRITTEN WHEN THE SWEEP STARTS, not when it finishes.
// That is the whole design. A sweep that crashes halfway leaves a row
// saying "started, never settled", which is precisely the evidence a
// finished-only record destroys. The same reasoning as the outbox: what
// you write before the risky part is what survives it.
//
// Diagnostic state, not business state. Every write here is wrapped and
// may fail silently; nothing in the sweep depends on it.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

export const SWEEP_RUN_TTL_DAYS = 7;

/** The scheduler has picked this query. Written before any fetching. */
export async function open({ sweepId, queryId, scheduledFor, startedAt, queuePosition, dueTotal }) {
  try {
    await collections.sweepRuns().insertOne({
      sweepId,
      queryId,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      startedAt: new Date(startedAt),
      finishedAt: null,
      status: "running",
      /* How late the scheduler was, separately from how long the crawl
         took. "Every five minutes" is a claim about this number, and
         until now nothing recorded it for a real sweep. */
      queueDelayMs: scheduledFor
        ? Math.max(0, new Date(startedAt).getTime() - new Date(scheduledFor).getTime())
        : null,
      /* Where this query sat in the due list, and how many were due.
         A query that is eleventh of eleven when only ten are taken is
         not late because LinkedIn was slow. */
      queuePosition: queuePosition ?? null,
      dueTotal: dueTotal ?? null,
      sources: {},
      at: new Date(),
    });
  } catch (err) {
    log.warn("could not open a sweep run record", { queryId: String(queryId), message: err.message });
  }
}

/** One source finished, one way or another. */
export async function noteSource({ sweepId, source, status, startedAt, finishedAt, error, jobs }) {
  try {
    await collections.sweepRuns().updateOne(
      { sweepId },
      { $set: { [`sources.${source}`]: {
        attempted: true, status,
        startedAt: startedAt ? new Date(startedAt) : null,
        finishedAt: finishedAt ? new Date(finishedAt) : null,
        ms: startedAt && finishedAt ? finishedAt - startedAt : null,
        error: error ? String(error).slice(0, 300) : null,
        jobs: jobs ?? null,
      } } }
    );
  } catch (err) {
    log.warn("could not record a source result", { source, message: err.message });
  }
}

/** The sweep ended. */
export async function close({ sweepId, status, fetched, alerted, error }) {
  try {
    await collections.sweepRuns().updateOne(
      { sweepId },
      { $set: {
        finishedAt: new Date(), status,
        fetched: fetched ?? null, alerted: alerted ?? null,
        error: error ? String(error).slice(0, 300) : null,
      } }
    );
  } catch (err) {
    log.warn("could not close a sweep run record", { message: err.message });
  }
}

/**
 * Every sweep of any query in a window, oldest first.
 *
 * The tracer's question: between the moment somebody saw a job and the
 * moment we discovered it, what did the scheduler actually do?
 */
export function inWindow(from, to, { queryId = null } = {}) {
  const q = { startedAt: { $gte: new Date(from), $lte: new Date(to) } };
  if (queryId) q.queryId = queryId;
  return collections.sweepRuns().find(q).sort({ startedAt: 1 }).toArray();
}
