// fetchCache.js
//
// One fetch per board per country per cycle, shared by every search in it.
//
// THE PROBLEM, measured on 2026-09-09 with five live searches:
//
//   last pass 93.1s
//   intern            saw 365/429
//   data analyst      saw   1/207   <- collapsed
//   business analyst  saw 233/233
//   data scientist    saw   2/202   <- collapsed
//   it                saw 300/300
//
// Two searches were returning almost nothing. Not a quiet morning —
// LinkedIn had started refusing us, because five searches in one country
// meant five full walks of its pages every cycle.
//
// And those five walks were fetching the same jobs. Measured the same day:
//
//   intern 209 · data analyst 191 · business analyst 203 · it 217
//   pairwise overlap 79-86%
//   four fetches -> 259 distinct jobs; the single largest alone -> 217
//
// Four requests bought 42 jobs over one, and cost the throttling that was
// wiping out 99% of two searches. That is a bad trade at five searches and
// an impossible one at fifty: the load scaled with SEARCHES when the thing
// being fetched only ever varied by COUNTRY.
//
// So a board is fetched once per country per cycle and every search in
// that country matches against the same result. Matching is local and
// free, so nothing downstream changes.
//
// TWO KINDS OF SOURCE, and the distinction is the whole safety argument:
//
//   · topjobs, MAS, XpressJobs and ITPro.lk ignore the keyword entirely —
//     they fetch a listing and filter it in the adapter. Sharing their
//     result is not an approximation, it is the identical bytes.
//
//   · LinkedIn does take a keyword, and returns a 79-86% identical set
//     whatever it is. Sharing loses the ~16% at the edges, so the keyword
//     driving the shared fetch ROTATES between cycles. Over a few passes
//     every search's own words get their turn, and nothing is lost for
//     good — the ledger means a job found later is still mailed once, and
//     never twice.
//
//   · Keells and Rooster genuinely filter server-side and are cheap
//     (5s and 1s), so they are left alone. Sharing those WOULD lose jobs.

import { log } from "../../utils/logger.js";

/* Long enough that one pass of the due queue shares a fetch, short enough
   that a search sweeping every five minutes never sees a stale set on its
   own next turn. */
const TTL_MS = 4 * 60_000;

/** Boards whose fetch does not depend on the keyword at all. */
const IGNORES_KEYWORDS = new Set(["topjobs", "mas", "xpress", "itpro"]);

/** Boards where sharing costs a little coverage, repaid by rotating. */
const ROTATES = new Set(["linkedin"]);

const cache = new Map();   // "source:geo" -> { at, jobs, keyword }
const turn = new Map();    // "source:geo" -> how many times we have rotated

export function isShared(sourceId) {
  return IGNORES_KEYWORDS.has(sourceId) || ROTATES.has(sourceId);
}

/**
 * Walk every page of one board, or hand back what the last search got.
 *
 * `fetchPages` does the actual paging; this only decides whether to call
 * it. Kept as a callback so the paging rules stay in sweep.js where they
 * are already explained.
 */
export async function sharedFetch(sourceId, geoId, want, fetchPages) {
  if (!isShared(sourceId)) return fetchPages(want.keywords);

  const key = `${sourceId}:${geoId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    log.debug("reusing this cycle's fetch", {
      source: sourceId, geoId, jobs: hit.jobs.length, ageMs: Date.now() - hit.at,
    });
    return hit.jobs;
  }

  /* Whose words drive the shared fetch.
     
     For a board that ignores keywords this is irrelevant and we pass the
     caller's. For LinkedIn it rotates, so that over successive cycles the
     set is driven by different searches and the edges each get covered. */
  let keywords = want.keywords;
  if (ROTATES.has(sourceId) && want.rotation?.length) {
    const n = (turn.get(key) || 0) % want.rotation.length;
    turn.set(key, n + 1);
    keywords = want.rotation[n];
  }

  const jobs = await fetchPages(keywords);
  cache.set(key, { at: Date.now(), jobs, keyword: (keywords || []).join("+") });
  log.info("fetched a board once for the whole country", {
    source: sourceId, geoId, jobs: jobs.length,
    drivenBy: (keywords || []).join("+") || "everything",
  });
  return jobs;
}

/**
 * Drop cached results.
 *
 * `keepRotation` exists because the two maps expire on different clocks in
 * production and a test that resets both is testing something the system
 * never does: the TTL retires a cached RESULT after four minutes, while
 * the rotation counter lives for the life of the process — that is the
 * only reason successive cycles are driven by different keywords. Clearing
 * both made rotation look broken when it was the test that was wrong.
 */
export function clearFetchCache({ keepRotation = false } = {}) {
  cache.clear();
  if (!keepRotation) turn.clear();
}
