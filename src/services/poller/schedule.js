// schedule.js
//
// WHO SWEEPS NEXT, and whether the promised cadence is possible at all.
//
// Pure: no database, no clock of its own, no network. Everything it
// needs arrives as arguments and everything it decides comes back as a
// value. That is not tidiness — it is what lets simulate.js run six
// hours of Job Wire in milliseconds and ask "who missed a deadline, how
// late, and why". Scheduler bugs are otherwise tested by waiting five
// minutes and hoping.
//
// THE PROBLEM THIS REPLACES. The loop asked the database once for ten
// due queries and then walked that frozen list. With LinkedIn at 78-92
// seconds a pass, ten queries is thirteen minutes during which the list
// is stale: a query becoming due at minute two is invisible until
// minute thirteen. A five-minute watch quietly becomes a fifteen-minute
// one with LinkedIn doing nothing wrong at all.
//
// So selection happens ONE query at a time, from the current state,
// immediately after the previous sweep finishes.

/** Capacity bands. Tunable; the boundaries are a judgement, U is not. */
export const HEALTHY = "HEALTHY";
export const NEAR_CAPACITY = "NEAR_CAPACITY";
export const OVERSUBSCRIBED = "OVERSUBSCRIBED";

/* A query overdue by more than this is STARVING and jumps the queue
   regardless of its cadence. Without it the fairness rule below eats
   itself: normalised lateness always favours short intervals, so a
   five-minute watch that can never keep up would outrank an hourly one
   for ever and the hourly one would never run at all.

   Three intervals, with a floor and a ceiling: a 5-minute watch starves
   at 15 minutes, an hourly watch at 30 rather than at three hours. */
export const STARVATION_INTERVALS = 3;
export const STARVATION_FLOOR_MS = 10 * 60_000;
export const STARVATION_CEILING_MS = 30 * 60_000;

export function starvationThresholdMs(intervalMs) {
  const scaled = intervalMs * STARVATION_INTERVALS;
  return Math.min(STARVATION_CEILING_MS, Math.max(STARVATION_FLOOR_MS, scaled));
}

/**
 * How overdue a query is, relative to what it asked for.
 *
 * Normalised, and that IS the fairness rule. A five-minute watch twelve
 * minutes late has missed more than two of its own cycles; an hourly
 * watch twelve minutes late has missed a fifth of one. Ranking by raw
 * lateness would treat those as equal and systematically starve fast
 * watches, which are the ones whose whole purpose is being fast.
 */
export function lateness(q, now) {
  const due = q.nextFetchAt ? new Date(q.nextFetchAt).getTime() : null;
  if (due == null) return null;                 // parked: not eligible
  const overdueMs = now - due;
  const intervalMs = Math.max(1, (q.everyMinutes || 5) * 60_000);
  return {
    overdueMs,
    intervalMs,
    /* Cycles missed. 0 means "due right now", 2 means "two whole
       intervals have gone by without a sweep". */
    normalised: overdueMs / intervalMs,
    starving: overdueMs >= starvationThresholdMs(intervalMs),
  };
}

/**
 * Pick the next query to sweep, or null when nothing is due.
 *
 * TWO TIERS, and the first exists solely to stop the second from
 * starving anybody:
 *
 *   STARVING  overdue past its own threshold. Ranked by ABSOLUTE
 *             lateness, so the longest-waiting goes first whatever its
 *             cadence.
 *   NORMAL    ranked by NORMALISED lateness, so cadence is respected:
 *             a 5-minute watch one cycle late outranks an hourly watch
 *             one minute late.
 *
 * Ties break on the oldest lastFetchedAt, so two identical queries
 * alternate rather than one always winning on document order.
 *
 * `exclude` is how the caller keeps a query that just failed from being
 * immediately reselected inside the same pass.
 */
export function selectNext(queries, now, { exclude = new Set() } = {}) {
  const eligible = [];
  for (const q of queries) {
    if (exclude.has(String(q._id))) continue;
    const late = lateness(q, now);
    if (!late || late.overdueMs < 0) continue;  // parked, or not due yet
    eligible.push({ q, late });
  }
  if (!eligible.length) return null;

  const starving = eligible.filter((e) => e.late.starving);
  const pool = starving.length ? starving : eligible;
  const key = starving.length
    ? (e) => e.late.overdueMs          // longest wait wins outright
    : (e) => e.late.normalised;        // cycles missed, so cadence counts

  pool.sort((a, b) => {
    const d = key(b) - key(a);
    if (d !== 0) return d;
    const at = a.q.lastFetchedAt ? new Date(a.q.lastFetchedAt).getTime() : 0;
    const bt = b.q.lastFetchedAt ? new Date(b.q.lastFetchedAt).getTime() : 0;
    return at - bt;                     // oldest observation first
  });

  const winner = pool[0];
  return {
    query: winner.q,
    reason: starving.length ? "starving" : "overdue",
    overdueMs: winner.late.overdueMs,
    normalised: winner.late.normalised,
    eligibleCount: eligible.length,
  };
}

/**
 * The next slot on a FIXED cadence, never "now plus the interval".
 *
 * "Every five minutes" is a claim about a grid — 10:00, 10:05, 10:10 —
 * not about the gap after a crawl happens to finish. Adding the
 * interval to the finish time made a five-minute watch run every six
 * and a half, drifting further the slower the board was, and it meant
 * the utilisation model and the scheduler were describing different
 * systems.
 *
 * MISSED SLOTS ARE NOT A BACKLOG. A process that wakes up twenty-five
 * minutes late owes ONE observation, not five crawls. Catching up would
 * aim a burst at the single source that answers being hammered by going
 * quiet, to deliver jobs that the one current sweep returns anyway.
 * They are counted and reported; they are never queued.
 */
export function nextSlot({ scheduledFor, intervalMs, now }) {
  const anchor = scheduledFor ? new Date(scheduledFor).getTime() : now;
  const step = Math.max(1, intervalMs);
  const elapsed = now - anchor;
  const slotsPassed = elapsed <= 0 ? 1 : Math.ceil(elapsed / step);
  return {
    at: new Date(anchor + slotsPassed * step),
    /* How many grid slots went by unswept. Zero on a healthy cadence;
       a number worth showing an operator when it is not. */
    missed: Math.max(0, slotsPassed - 1),
  };
}

/**
 * Can the requested schedules actually be met?
 *
 *   U = Σ (observed service time / requested interval)
 *
 * over the queries sharing one serial lane. U < 1 means the lane has
 * room; U > 1 means the configuration is arithmetically impossible and
 * sweeps fall further behind every cycle, for ever. That is not slow,
 * it is unachievable, and the difference matters because only one of
 * them is fixed by waiting.
 *
 * Queries with no measured service time are EXCLUDED rather than
 * guessed at. A default would make U confidently wrong in whichever
 * direction it leaned, and being confidently wrong about capacity is
 * worse than admitting the sample is thin.
 */
export function utilisation(queries, { defaultServiceMs = null } = {}) {
  const contributions = [];
  let unmeasured = 0;

  for (const q of queries) {
    if (q.nextFetchAt == null) continue;                    // parked
    const serviceMs = Number.isFinite(q.serviceMsAvg)
      ? q.serviceMsAvg
      : (defaultServiceMs ?? null);
    if (!Number.isFinite(serviceMs) || serviceMs <= 0) { unmeasured++; continue; }
    const intervalMs = Math.max(1, (q.everyMinutes || 5) * 60_000);
    contributions.push({
      queryId: String(q._id),
      keywords: (q.keywords || []).join("+") || "everything",
      everyMinutes: q.everyMinutes,
      serviceMs,
      share: serviceMs / intervalMs,
    });
  }

  contributions.sort((a, b) => b.share - a.share);
  const U = contributions.reduce((n, c) => n + c.share, 0);

  /* What cadence the current work COULD sustain, if the lane were
     shared evenly. The honest number to show somebody whose watch says
     five minutes on an oversubscribed lane. */
  const totalServiceMs = contributions.reduce((n, c) => n + c.serviceMs, 0);
  const sustainableIntervalMs = contributions.length ? totalServiceMs : null;

  return {
    U,
    state: U > 1 ? OVERSUBSCRIBED : U >= 0.75 ? NEAR_CAPACITY : HEALTHY,
    measured: contributions.length,
    unmeasured,
    sustainableIntervalMs,
    sustainableMinutes: sustainableIntervalMs
      ? Math.ceil(sustainableIntervalMs / 60_000)
      : null,
    contributions,
  };
}

/**
 * What to tell somebody whose watch cannot be honoured.
 *
 * Deliberately per-query rather than a global banner: "the lane is at
 * 130%" means nothing to a reader, and "your five-minute watch is
 * realistically eight minutes right now" means everything.
 */
export function cadenceReality(q, u) {
  const requested = q.everyMinutes;
  if (!u || u.state !== OVERSUBSCRIBED || !u.sustainableMinutes) {
    return { requested, sustainable: requested, honest: true };
  }
  const sustainable = Math.max(requested, u.sustainableMinutes);
  return { requested, sustainable, honest: sustainable <= requested };
}
