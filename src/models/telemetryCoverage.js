// telemetryCoverage.js
//
// From when is "we have no record of that" allowed to mean anything?
//
// THE MISTAKE THIS EXISTS TO PREVENT, which has already been made once:
// the tracer looked for crawl-log rows in a window, found none, and
// printed "the crawler did not walk LinkedIn at all in that window".
// The window was 08:11-08:47. The crawl log shipped at 14:35 the same
// day. There could not have been a row, and the sentence was reported
// upward as a scheduling finding.
//
// That is the exact failure this whole project keeps having, turned
// inward: a measurement that cannot distinguish "it did not happen"
// from "nobody was writing it down", and defaults to the first.
//
// Two things bound what the telemetry can speak to:
//
//   WHEN IT STARTED. A collection written by code deployed at 14:35 says
//   nothing about 08:47.
//
//   HOW LONG IT KEEPS. crawlLog expires after 7 days, so a window from
//   three weeks ago is equally unanswerable even though the code existed.
//
// Absence is only evidence inside the intersection of those two.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";
import { CRAWL_LOG_TTL_DAYS } from "./crawlLog.js";

/**
 * Note that this build writes a given kind of telemetry.
 *
 * $setOnInsert, so the FIRST process to boot with the instrumentation
 * stamps the moment and every later boot leaves it alone. Re-stamping on
 * every restart would keep moving the horizon forward and make older
 * windows look uncovered when they were.
 */
export async function markAvailable(kind) {
  try {
    await collections.telemetryCoverage().updateOne(
      { _id: kind },
      { $setOnInsert: { since: new Date(), kind } },
      { upsert: true }
    );
  } catch (err) {
    log.warn("could not mark telemetry coverage", { kind, message: err.message });
  }
}

const RETENTION_DAYS = { crawlLog: CRAWL_LOG_TTL_DAYS, sweepRuns: CRAWL_LOG_TTL_DAYS };

/**
 * Can absence of `kind` between two instants be read as "it did not
 * happen"?
 *
 * Returns { covered, since, reason }. `covered: false` means the honest
 * answer to any question about that window is "we do not know", and the
 * caller must say so rather than inferring.
 */
export async function coverage(kind, from, to = new Date()) {
  let row = null;
  try {
    row = await collections.telemetryCoverage().findOne({ _id: kind });
  } catch { /* treated as uncovered below, which is the safe direction */ }

  if (!row?.since) {
    return { covered: false, since: null, reason: `${kind} has never been recorded` };
  }

  const ttlDays = RETENTION_DAYS[kind];
  const expiresBefore = ttlDays ? new Date(Date.now() - ttlDays * 86_400_000) : null;
  /* The later of "when we started writing it" and "how far back it still
     exists". Both have to hold. */
  const effective = expiresBefore && expiresBefore > row.since ? expiresBefore : row.since;

  if (new Date(from) < effective) {
    return {
      covered: false,
      since: effective,
      reason: expiresBefore && expiresBefore > row.since
        ? `${kind} only keeps ${ttlDays} days; this window is older`
        : `${kind} instrumentation only started at ${effective.toISOString()}`,
    };
  }
  if (new Date(to) < effective) {
    return { covered: false, since: effective, reason: `${kind} did not cover this window` };
  }
  return { covered: true, since: effective, reason: null };
}
