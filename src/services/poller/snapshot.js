// snapshot.js
//
// One fetch of one board for one country, pinned for the pass that took
// it, immutable once taken.
//
// This replaces a four-minute wall-clock TTL, and the difference is not
// cosmetic. The old cache said "one fetch per board per country per
// cycle" and the code said "four minutes of process memory". Those agree
// only while a pass over the due queue finishes inside four minutes, and
// it will not: LinkedIn alone is about eighty seconds per search, so the
// pass outgrows the window at roughly three searches — which is exactly
// where this system's trouble starts. Past that, a later search in the
// SAME logical pass refetches a board an earlier one already had, and
// the shared-fetch saving quietly erodes precisely as scale makes it
// matter.
//
// So the unit is the PASS, not the clock. A pass opens, takes at most
// one snapshot per (source, country), and every query in that pass reads
// the same one however long the pass runs.
//
// TWO OTHER PROPERTIES, both of which the old cache lacked:
//
// IMMUTABLE. The snapshot's jobs array is frozen and handed out as-is.
// The first version of the shared cache stored the ADAPTER'S FILTERED
// result, so whichever search drove the fetch decided what every other
// search in the country saw — a watch for "intern" was handed the "IT"
// search's results and filled with IT Manager and Senior Executive - IT.
// A matcher must never be able to change what the next matcher sees, and
// freezing is the cheapest way to make that structural rather than
// remembered.
//
// SHARED IN FLIGHT. Two queries reaching the same board at the same
// moment used to make two requests, because the cache was only written
// after the first one finished. The promise is stored, not the result,
// so the second caller waits for the first rather than racing it.

import { randomUUID } from "node:crypto";
import { log } from "../../utils/logger.js";

/* Boards that fetch a whole listing and then filter it in the adapter.
 *
 * These are shared by asking for the listing UNFILTERED and letting the
 * sweep apply each search's own words afterwards. That distinction is
 * the whole safety argument; see the note above about what happened when
 * the filtered result was cached instead.
 */
const SHARE_UNFILTERED = new Set(["topjobs", "mas", "xpress", "itpro"]);

/* LinkedIn is NOT shared.
 *
 * Its keyword is not a filter over one listing: the adapter unions a
 * keyword query with the country feed, and keeps jobs whose TITLE never
 * matches because the employer tagged them Internship. There is no
 * unfiltered result to share that preserves that, so sharing it either
 * loses the tag matches or hands one search another's. Its cost is real
 * and the fix is to share only the country-feed half of what it fetches,
 * which is a change inside the adapter rather than a cache around it. */

export function isShared(sourceId) {
  return SHARE_UNFILTERED.has(sourceId);
}

/**
 * A backstop, not the mechanism.
 *
 * The pass is what bounds a snapshot's life. This only catches a pass
 * that was never closed — a crash between openPass and closePass, or a
 * caller that forgot — so it is deliberately much longer than any
 * plausible pass rather than tuned to one.
 */
const ABANDONED_PASS_MS = 30 * 60_000;

let current = null;   // { id, startedAt, snapshots: Map, inFlight: Map }

/**
 * Begin a pass over the due queue.
 *
 * Idempotent within a pass: calling it again while one is open returns
 * the same pass, so a caller that is unsure whether it opened one cannot
 * accidentally throw away the snapshots already taken.
 */
export function openPass() {
  if (current && Date.now() - current.startedAt < ABANDONED_PASS_MS) return current.id;
  if (current) {
    log.warn("a sweep pass was never closed — starting a fresh one", {
      abandoned: current.id, ageMs: Date.now() - current.startedAt,
      snapshots: current.snapshots.size,
    });
  }
  current = {
    id: randomUUID().slice(0, 8),
    startedAt: Date.now(),
    snapshots: new Map(),
    inFlight: new Map(),
  };
  return current.id;
}

/**
 * End it, and let the snapshots go.
 *
 * Releasing here rather than on a timer is what makes the next pass
 * fetch fresh listings however long this one took — and what stops a
 * long pass from serving a search a set of jobs from half an hour ago.
 */
export function closePass() {
  if (!current) return null;
  const summary = {
    pass: current.id,
    ms: Date.now() - current.startedAt,
    snapshots: current.snapshots.size,
    jobs: [...current.snapshots.values()].reduce((n, s) => n + s.jobs.length, 0),
  };
  current = null;
  return summary;
}

/** What this pass has taken so far, for logs and tests. */
export function passInfo() {
  if (!current) return null;
  return {
    id: current.id,
    startedAt: new Date(current.startedAt),
    ms: Date.now() - current.startedAt,
    snapshots: [...current.snapshots.values()].map((s) => ({
      source: s.source, country: s.country, snapshotId: s.snapshotId,
      fetchedAt: s.fetchedAt, jobs: s.jobs.length,
    })),
  };
}

/**
 * The snapshot of one board for one country in this pass, taking it if
 * nobody has yet.
 *
 * `fetchPages` does the actual paging; this only decides whether to call
 * it. Kept as a callback so the paging rules stay in sweep.js where they
 * are already explained — and so the caller decides, per source, whether
 * it is asking for a whole listing or for its own filtered set.
 *
 * With no pass open this simply fetches. Nothing outside the poller has
 * a pass, and a lone call — a test, a manual sweep — should not silently
 * read somebody else's snapshot.
 */
export async function sharedFetch(sourceId, geoId, fetchPages) {
  if (!isShared(sourceId)) return fetchPages();
  if (!current) return fetchPages();

  const key = `${sourceId}:${geoId}`;

  const taken = current.snapshots.get(key);
  if (taken) {
    log.debug("reusing this pass's snapshot", {
      source: sourceId, geoId, pass: current.id,
      snapshot: taken.snapshotId, jobs: taken.jobs.length,
      ageMs: Date.now() - taken.fetchedAt.getTime(),
    });
    return taken.jobs;
  }

  /* Somebody is already fetching it. Wait for them rather than making a
     second request: the old cache only wrote AFTER the fetch returned,
     so two queries reaching the same board together both fetched it. */
  const inFlight = current.inFlight.get(key);
  if (inFlight) {
    log.debug("waiting on a snapshot another query is already taking", {
      source: sourceId, geoId, pass: current.id,
    });
    return inFlight;
  }

  const pass = current;                  // pinned: the pass may close under us
  const work = (async () => {
    /* Fetched with NO keyword, so the snapshot belongs to the country
       rather than to whichever search happened to ask first. The caller
       filters it, and cannot change it. */
    const jobs = Object.freeze(await fetchPages());
    const snapshot = Object.freeze({
      source: sourceId,
      country: geoId,
      snapshotId: randomUUID().slice(0, 8),
      fetchedAt: new Date(),
      jobs,
    });
    // Only if this pass is still the open one. A snapshot belonging to a
    // pass that has ended must not be handed to the next one.
    if (pass === current) pass.snapshots.set(key, snapshot);
    log.info("took a snapshot of a board for the whole country", {
      source: sourceId, geoId, pass: pass.id,
      snapshot: snapshot.snapshotId, jobs: jobs.length,
    });
    return jobs;
  })();

  pass.inFlight.set(key, work);
  try {
    return await work;
  } finally {
    pass.inFlight.delete(key);
  }
}

/** Drop everything. Used between tests, and by a manual reset. */
export function clearSnapshots() {
  current = null;
}
