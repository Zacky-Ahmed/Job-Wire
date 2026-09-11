// observations.js
//
// What each source and each surface did, kept long enough to answer
// "when did this stop working?"
//
// The admin page's source health was derived from the last sweep's
// failures and a lifetime high-water mark. Neither can answer the
// question that matters: a surface that has been returning nothing for
// six days looks identical to one that returned nothing this morning,
// and trackedPeak is a number from whenever the board was busiest, which
// may have been in March.
//
// So every sweep writes down what it saw, per source and per surface,
// and the rows expire. A rolling baseline over the recent ones is what
// makes "this is unusual" a measurement rather than an impression.
//
// The rows are small — counts and a status, no job data — so the TTL can
// be generous enough to cover a holiday: two weeks is long enough to
// tell a quiet fortnight from a broken parser.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

export const OBSERVATION_TTL_DAYS = 14;

/** One sweep's worth, for one source. */
export async function record({ source, geoId, queryId, observation, ms }) {
  try {
    await collections.observations().insertOne({
      source,
      geoId,
      queryId,
      status: observation.status,
      requests: observation.requests,
      pages: observation.pages,
      rawCount: observation.rawCount,
      parsedCount: observation.parsedCount,
      /* Stored as an array rather than an object so it can be queried.
         Mongo cannot index a field whose NAME varies, and "which surface
         is failing" is exactly the query this collection exists for. */
      surfaces: Object.entries(observation.surfaces || {}).map(([name, s]) => ({
        name, ...s,
      })),
      warnings: observation.warnings || [],
      /* Standing properties of the source rather than faults — partial
         topjobs coverage, ITPro exposing only its newest page. Kept
         apart from warnings so they can be shown without turning every
         healthy sweep into a degraded one. */
      notes: observation.notes || [],
      reported: observation.reported !== false,
      ms,
      at: new Date(),
    });
  } catch (err) {
    // Bookkeeping must never fail the sweep it is describing.
    log.warn("could not record a source observation", { source, message: err.message });
  }
}

/**
 * A rolling picture of one surface, for deciding whether today is odd.
 *
 * The median rather than the mean, because one enormous day — a board
 * dumping a backlog — should not raise the bar for every day after it.
 *
 * HEALTHY SAMPLES ONLY, and that is the difference between a monitor and
 * a monitor that learns the outage. This used to average everything
 * recorded, degraded observations included. So:
 *
 *   healthy    200  205  198  202
 *   collapse     2    3    1    4    2    2    3 ...
 *
 * the rolling median walks down towards 2, and within a day or so two
 * jobs stops looking unusual. The monitor would have quietly agreed that
 * the outage was the new normal — exactly when somebody most needed it
 * to still be shouting.
 *
 * A broken surface must never get a vote on what working looks like.
 */
export async function baseline({ source, surface = null, geoId = null, days = 7 }) {
  const since = new Date(Date.now() - days * 86_400_000);
  const match = { source, at: { $gte: since }, status: "healthy" };
  if (geoId) match.geoId = geoId;

  const rows = await collections.observations()
    .find(match, { projection: { parsedCount: 1, surfaces: 1, status: 1 } })
    .toArray();
  if (!rows.length) return null;

  /* And within a healthy observation, only surfaces that were themselves
     ok. A sweep can be healthy overall while one surface returned
     nothing recognisable — that zero must not count towards what that
     surface normally does. */
  const counts = surface
    ? rows
        .map((r) => (r.surfaces || []).find((s) => s.name === surface))
        .filter((s) => s && s.ok !== false && Number.isFinite(s.parsedCount))
        .map((s) => s.parsedCount)
    : rows.map((r) => r.parsedCount).filter((n) => Number.isFinite(n));

  if (!counts.length) return null;
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  /* Counted over ALL observations, not the healthy ones the baseline is
     built from — the whole point is to know how much has been going
     wrong, and a window filtered to healthy rows cannot say. */
  const total = await collections.observations().countDocuments({
    source, at: { $gte: since }, ...(geoId ? { geoId } : {}),
  });
  const degraded = total - rows.length;

  return {
    source, surface, samples: counts.length, median,
    min: sorted[0], max: sorted[sorted.length - 1],
    degraded,
    degradedShare: total ? degraded / total : 0,
  };
}

/**
 * How many sweeps in a row this source has been degraded.
 *
 * Kept separate from the baseline because a healthy-only baseline
 * cannot see an outage at all — by design — and something still has to
 * notice that the last forty observations were all bad. Counting
 * backwards from now stops at the first healthy one.
 */
export async function consecutiveDegraded({ source, geoId = null, limit = 100 }) {
  const rows = await collections.observations()
    .find({ source, ...(geoId ? { geoId } : {}) }, { projection: { status: 1 } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
  let n = 0;
  for (const r of rows) {
    if (r.status === "healthy") break;
    n++;
  }
  return n;
}

/**
 * Is what we just saw a departure from what this surface normally does?
 *
 * Deliberately conservative. Twenty per cent of the usual is a
 * collapse; sixty per cent is a Tuesday. Below a handful of samples it
 * declines to have an opinion at all, because two data points cannot
 * establish a normal and a false alarm on day one teaches people to
 * ignore the alarm.
 */
export function isAnomalous(observed, base, { floor = 0.2, minSamples = 5 } = {}) {
  if (!base || base.samples < minSamples) return null;
  if (base.median === 0) return null;        // it normally returns nothing
  if (observed >= base.median * floor) return false;
  return true;
}

/** Everything recorded lately, newest first — for the admin page. */
export function recent({ limit = 200 } = {}) {
  return collections.observations()
    .find({}, { projection: { source: 1, geoId: 1, status: 1, parsedCount: 1, surfaces: 1, warnings: 1, at: 1 } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}
