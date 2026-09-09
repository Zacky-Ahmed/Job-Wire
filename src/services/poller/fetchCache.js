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

/* Boards that fetch a whole listing and then filter it in the adapter.
 *
 * These are shared by asking for the listing UNFILTERED and letting the
 * sweep apply each search's own words afterwards. That distinction is not
 * a detail: the first version cached the adapter's FILTERED result, so
 * whichever search drove the fetch decided what every other search in the
 * country saw. A watch for "intern" was handed the "IT" search's results
 * and filled with IT Manager, IT Technician and Senior Executive - IT.
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

const cache = new Map();   // "source:geo" -> { at, jobs }

export function isShared(sourceId) {
  return SHARE_UNFILTERED.has(sourceId);
}

/**
 * Walk every page of one board, or hand back what the last search got.
 *
 * `fetchPages` does the actual paging; this only decides whether to call
 * it. Kept as a callback so the paging rules stay in sweep.js where they
 * are already explained — and so the caller decides, per source, whether
 * it is asking for a whole listing or for its own filtered set.
 */
export async function sharedFetch(sourceId, geoId, fetchPages) {
  if (!isShared(sourceId)) return fetchPages();

  const key = `${sourceId}:${geoId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    log.debug("reusing this cycle's fetch", {
      source: sourceId, geoId, jobs: hit.jobs.length, ageMs: Date.now() - hit.at,
    });
    return hit.jobs;
  }

  /* Fetched with NO keyword, so the cached listing belongs to the country
     rather than to whichever search happened to ask first. The caller
     filters it. */
  const jobs = await fetchPages();
  cache.set(key, { at: Date.now(), jobs });
  log.info("fetched a board once for the whole country", {
    source: sourceId, geoId, jobs: jobs.length,
  });
  return jobs;
}

/** Drop cached results. */
export function clearFetchCache() {
  cache.clear();
}
