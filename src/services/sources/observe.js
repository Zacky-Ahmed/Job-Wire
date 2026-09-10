// observe.js
//
// What a source adapter actually DID, as distinct from what it returned.
//
// Health used to be one number: how many jobs the sweep ended up with.
// That number cannot distinguish the three things it is asked to:
//
//   · a board that is genuinely quiet today;
//   · a board that answered 200 with markup we no longer understand, so
//     the parser found nothing;
//   · one of LinkedIn's three surfaces collapsing while the other two,
//     and the five local boards, keep the total looking normal.
//
// All three produce "we saw fewer jobs". Only the first is fine, and it
// is the least likely. The others are the failure this project keeps
// having — reports success, quietly does less — and an aggregate count
// is structurally incapable of catching them.
//
// So an adapter may now return an OBSERVATION alongside its jobs:
//
//   {
//     jobs,
//     observation: {
//       status: "healthy" | "degraded",
//       requests, pages, rawCount, parsedCount,
//       surfaces: { countryFeed: {...}, guestKeyword: {...}, ... },
//       warnings: []
//     }
//   }
//
// A COMPLETE failure still throws — that path already worked and the
// sweep already records it. What was missing is the middle: a partial
// success that looks total. "degraded" is that middle, and it exists so
// that a surface going dark is visible on the day it happens rather than
// on the day somebody notices the alerts stopped.
//
// Returning a bare Job[] is still valid. Every adapter did that
// yesterday, and rewriting seven of them in one change would mean seven
// chances to break a working crawl in a commit whose purpose is to make
// breakage visible.

export const HEALTHY = "healthy";
export const DEGRADED = "degraded";

/**
 * Accept either shape and always hand back the rich one.
 *
 * An adapter that returns a bare array is reported as healthy with the
 * counts we can infer and nothing we cannot. It is deliberately not
 * marked "unknown": the sweep succeeded, the array is the answer, and
 * inventing a third status for "this adapter has not been updated yet"
 * would put a warning on screen that no operator can act on.
 */
export function normalize(result, { source, surfaceHint = null } = {}) {
  if (Array.isArray(result)) {
    return {
      jobs: result,
      observation: {
        source,
        status: HEALTHY,
        requests: null,
        pages: null,
        rawCount: null,
        parsedCount: result.length,
        surfaces: surfaceHint ? { [surfaceHint]: { parsedCount: result.length } } : {},
        warnings: [],
        notes: [],
        reported: false,          // the adapter said nothing; this is inferred
      },
    };
  }
  const jobs = result?.jobs || [];
  const obs = result?.observation || {};
  return {
    jobs,
    observation: {
      source,
      status: obs.status || HEALTHY,
      requests: obs.requests ?? null,
      pages: obs.pages ?? null,
      rawCount: obs.rawCount ?? null,
      parsedCount: obs.parsedCount ?? jobs.length,
      surfaces: obs.surfaces || {},
      warnings: obs.warnings || [],
      notes: obs.notes || [],
      reported: true,
    },
  };
}

/**
 * A small builder, so an adapter counting its own work does not have to
 * remember the shape.
 */
export function observer(source) {
  const surfaces = {};
  const warnings = [];
  const notes = [];
  let requests = 0;
  let pages = 0;
  let rawCount = 0;

  return {
    /** One HTTP call happened. */
    request(n = 1) { requests += n; return this; },
    /** One page of results was walked. */
    page(n = 1) { pages += n; return this; },
    /** How many rows the response contained BEFORE parsing or filtering. */
    raw(n) { rawCount += n; return this; },

    /**
     * Record what one surface did.
     *
     * `ok: false` is what makes the whole observation degraded. A surface
     * that answered but returned nothing recognisable is NOT ok, however
     * cheerful its HTTP status was.
     */
    surface(name, { ok = true, requests: r = 0, pages: p = 0, rawCount: raw = 0, parsedCount = 0, error = null, note = null } = {}) {
      surfaces[name] = { ok, requests: r, pages: p, rawCount: raw, parsedCount, error, note };
      requests += r;
      pages += p;
      rawCount += raw;
      if (!ok) warnings.push(`${name}: ${error || note || "returned nothing usable"}`);
      return this;
    },

    /** Something went wrong. Makes the observation degraded. */
    warn(message) { warnings.push(message); return this; },

    /**
     * A standing property of this source, which is NOT a fault.
     *
     * "topjobs crawls three of ~31 areas" and "ITPro exposes only its
     * newest page" are both true on a perfectly healthy sweep. Put them
     * through warn() and every single observation is degraded for ever,
     * which trains whoever reads the admin page to ignore the word —
     * and the word is the only thing that will tell them a surface has
     * actually collapsed. Recorded, visible, and status-neutral.
     */
    note(message) { notes.push(message); return this; },

    /**
     * Finish.
     *
     * Degraded when any surface failed or anything warned. Deliberately
     * NOT degraded merely for returning zero jobs: a recognised empty
     * state is a real answer, and treating "quiet Sunday" as a fault
     * trains people to ignore the signal that matters.
     */
    done(jobs) {
      const anyFailed = Object.values(surfaces).some((s) => !s.ok);
      return {
        jobs,
        observation: {
          source,
          status: anyFailed || warnings.length ? DEGRADED : HEALTHY,
          requests, pages, rawCount,
          parsedCount: jobs.length,
          surfaces,
          warnings,
          notes,
          reported: true,
        },
      };
    },
  };
}

/**
 * Did an HTML page still look like the page we wrote a parser for?
 *
 * The specific failure this exists for: a board changes its markup, the
 * server keeps answering 200, our selectors match nothing, and the
 * adapter returns an empty array that is indistinguishable from a day
 * with no jobs. topjobs, Keells and ITPro are all scraped this way and
 * all three can fail exactly like that.
 *
 * The invariant is not "we found jobs" — a board really can have none.
 * It is "the page contained the structure we parse". If the container is
 * there and holds rows, zero parsed jobs is a genuine empty state. If
 * the container is not there at all, the page is not the page we think
 * it is, whatever it returned.
 */
export function checkPageShape({ html, containerFound, rowsFound, parsedCount, minBytes = 500 }) {
  if (!html || html.length < minBytes) {
    return { ok: false, error: `response was ${html ? html.length : 0} bytes — too short to be the page` };
  }
  if (!containerFound) {
    return { ok: false, error: "the listing container is missing — the page shape has changed" };
  }
  if (rowsFound > 0 && parsedCount === 0) {
    return { ok: false, error: `found ${rowsFound} rows but parsed none of them — the row shape has changed` };
  }
  // Container present, no rows: a real empty listing.
  return { ok: true };
}
