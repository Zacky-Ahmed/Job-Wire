// topjobsCorpus.js
//
// topjobs as a country corpus, refreshed on its own clock.
//
// MEASURED, 2026-09-10, with the adapter's own parser (npm run probe-topjobs):
//
//   31 functional areas, 5,261 open vacancies
//   the 3 areas the adapter crawled reached 336 of them — SIX PER CENT
//   4,925 vacancies were invisible to every watch in the system
//
// So a watch for an accounting, hospitality, HR or civil-engineering
// internship believed it had topjobs coverage and had never had a single
// page of its own area fetched. Accounting alone carries 736 open
// vacancies — more than twice the entire reach of the old crawl. That is
// a bigger hole than any parser bug, and nothing anywhere would have
// shown it: the adapter returned jobs, the counts looked normal, and the
// missing 94% simply never existed as far as the system was concerned.
//
// WHY NOT JUST FETCH ALL 31 PER SWEEP. That is 31 requests to one host
// on a five-minute clock, ten times the current load on a board that has
// never rate-limited us — which is a good way to make it start. The
// board is also a country-level fact, not a per-watch one: every watch
// in Sri Lanka wants the same 5,261 vacancies filtered differently.
//
// So the areas are crawled INDEPENDENTLY of any watch, a few per pass,
// oldest-first within a tier. Every area is covered; none of them is
// covered on every sweep; and the per-pass cost is bounded by a budget
// rather than by how many areas exist.
//
// THE TIERS ARE A PROXY AND SHOULD BE TREATED AS ONE. They are set from
// the number of OPEN vacancies, because that is what could be measured
// in one afternoon. What actually matters for alert latency is CHURN —
// how many new postings an area gains per hour — and an area with 736
// open vacancies may add fewer per day than one with 20. Churn cannot be
// measured without watching over time, which the observations collection
// now makes possible; when there is a week of data, these tiers should
// be re-derived from it rather than from this snapshot.

import { log } from "../../utils/logger.js";

/* Every functional area topjobs publishes, with its open-vacancy count
   from the measurement above. Written down rather than discovered per
   run: discovering them costs a request and they change about never, and
   a stale entry here fails visibly (an area returning nothing) rather
   than invisibly (an area nobody asked for). Re-check with
   npm run probe-topjobs. */
export const AREAS = [
  // hot — the five largest, 49% of the board between them
  { fa: "ACA", name: "Accounting/Auditing/Finance", open: 736, tier: "hot" },
  { fa: "SMM", name: "Sales/Marketing/Merchandising", open: 725, tier: "hot" },
  { fa: "HRF", name: "Hotel/Restaurant/Hospitality", open: 438, tier: "hot" },
  { fa: "CCE", name: "Civil Eng/Interior Design/Architecture", open: 376, tier: "hot" },
  { fa: "LWT", name: "Logistics/Warehouse/Transport", open: 319, tier: "hot" },
  // warm
  { fa: "MAE", name: "Eng-Mech/Auto/Elec", open: 286, tier: "warm" },
  { fa: "BAF", name: "Banking & Finance/Insurance", open: 273, tier: "warm" },
  { fa: "HAT", name: "HR/Training", open: 259, tier: "warm" },
  { fa: "OAS", name: "Office Admin/Secretary/Receptionist", open: 245, tier: "warm" },
  { fa: "TAL", name: "Education", open: 189, tier: "warm" },
  { fa: "SDQ", name: "IT-Sware/DB/QA/Web/Graphics/GIS", open: 165, tier: "warm" },
  { fa: "APC", name: "Apparel/Clothing", open: 153, tier: "warm" },
  { fa: "MHN", name: "Medical/Nursing/Healthcare", open: 137, tier: "warm" },
  { fa: "POS", name: "Manufacturing/Operations", open: 119, tier: "warm" },
  { fa: "CUR", name: "Customer Relations/Public Relations", open: 117, tier: "warm" },
  // cold
  { fa: "HNS", name: "IT-HWare/Networks/Systems", open: 94, tier: "cold" },
  { fa: "COM", name: "Corporate Management/Analysts", open: 77, tier: "cold" },
  { fa: "SQC", name: "Supervision/Quality Control", open: 75, tier: "cold" },
  { fa: "MAC", name: "Media/Advert/Communication", open: 73, tier: "cold" },
  { fa: "KPO", name: "KPO/BPO", open: 68, tier: "cold" },
  { fa: "HOT", name: "Travel/Tourism", open: 64, tier: "cold" },
  { fa: "LEL", name: "Legal/Law", open: 58, tier: "cold" },
  { fa: "IDV", name: "International Development", open: 40, tier: "cold" },
  { fa: "AGD", name: "Agriculture/Dairy/Environment", open: 35, tier: "cold" },
  { fa: "RLT", name: "R&D/Science/Research", open: 34, tier: "cold" },
  { fa: "IME", name: "Imports/Exports", open: 27, tier: "cold" },
  { fa: "AIM", name: "Ticketing/Airline/Marine", open: 26, tier: "cold" },
  { fa: "SEC", name: "Security", open: 20, tier: "cold" },
  { fa: "ITT", name: "IT-Telecoms", open: 18, tier: "cold" },
  { fa: "BEC", name: "Fashion/Design/Beauty", open: 10, tier: "cold" },
  { fa: "SRF", name: "Sports/Fitness/Recreation", open: 5, tier: "cold" },
];

/* How stale an area may get before it is due again.

   Chosen so the whole board is reachable at a cost the board will
   tolerate: 5 hot every 10 minutes, 10 warm every 30, 16 cold every 90
   works out at roughly one request a minute, or about five per
   five-minute pass. The budget below is what actually bounds it. */
const REFRESH_MS = {
  hot: 10 * 60_000,
  warm: 30 * 60_000,
  cold: 90 * 60_000,
};

/* How many areas one pass may fetch. The ceiling on cost, and the reason
   adding an area to the list cannot make a sweep slower — it makes every
   area come round slightly less often instead, which is a much better
   failure than a crawl that grows without bound. */
export const REFRESH_BUDGET = 6;

/* fa -> { jobs, fetchedAt, ok, error }
   Process memory. A restart starts cold and refills over the following
   half hour, which costs a delay rather than an alert: everything found
   is written to seenJobs on discovery, and an area not yet refreshed is
   simply an area whose new jobs arrive on the next pass. */
const corpus = new Map();

const dueAt = (entry, area) =>
  entry ? entry.fetchedAt + REFRESH_MS[area.tier] : 0;

/**
 * Which areas are most overdue, up to the budget.
 *
 * Sorted by how far past due they are rather than by tier, so a cold
 * area that has been waiting two hours is fetched before a hot one that
 * is thirty seconds late. Tiers decide how often; lateness decides the
 * order.
 */
export function dueAreas(now = Date.now(), budget = REFRESH_BUDGET) {
  return AREAS
    .map((area) => ({ area, due: dueAt(corpus.get(area.fa), area) }))
    .filter(({ due }) => due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, budget)
    .map(({ area }) => area);
}

/**
 * Refresh the due areas and return the whole corpus.
 *
 * `fetchArea(fa)` is injected so the paging, charset and parsing stay in
 * the adapter and this file stays about scheduling.
 */
export async function refresh(fetchArea, { now = Date.now(), budget = REFRESH_BUDGET } = {}) {
  const due = dueAreas(now, budget);
  const results = [];

  for (const area of due) {
    try {
      const jobs = await fetchArea(area);
      corpus.set(area.fa, { jobs, fetchedAt: Date.now(), ok: true, error: null });
      results.push({ area, ok: true, jobs: jobs.length });
    } catch (err) {
      /* The previous corpus for this area is KEPT. A failed refresh
         means "we could not look just now", not "this area is empty" —
         dropping the jobs would make a transient 503 look exactly like a
         board that closed every one of its accounting vacancies. */
      const held = corpus.get(area.fa);
      if (held) held.ok = false, held.error = err.message;
      results.push({ area, ok: false, error: err.message });
    }
  }

  if (results.length) {
    log.info("refreshed part of the topjobs corpus", {
      refreshed: results.filter((r) => r.ok).map((r) => r.area.fa).join(","),
      failed: results.filter((r) => !r.ok).map((r) => r.area.fa).join(",") || undefined,
      covered: `${corpus.size}/${AREAS.length} areas`,
    });
  }

  return results;
}

/**
 * Everything the corpus holds, de-duplicated.
 *
 * A vacancy can be listed under more than one area with the same job
 * code, so the Map collapses it rather than letting it alert twice.
 */
export function all() {
  const seen = new Map();
  for (const [fa, entry] of corpus) {
    const area = AREAS.find((a) => a.fa === fa);
    for (const job of entry.jobs) {
      if (!seen.has(job.jobId)) seen.set(job.jobId, { ...job, area: area?.name });
    }
  }
  return [...seen.values()];
}

/** How much of the board we can currently see, and how fresh it is. */
export function coverage(now = Date.now()) {
  const held = AREAS.filter((a) => corpus.has(a.fa));
  const stale = held.filter((a) => now > dueAt(corpus.get(a.fa), a));
  const openCovered = held.reduce((n, a) => n + a.open, 0);
  const openTotal = AREAS.reduce((n, a) => n + a.open, 0);
  return {
    areas: held.length,
    ofAreas: AREAS.length,
    stale: stale.length,
    failing: held.filter((a) => corpus.get(a.fa).ok === false).length,
    /* Weighted by the vacancy counts measured at the time the tiers were
       set, so "we have 20 of 31 areas" does not read as 65% coverage
       when those 20 happen to be the small ones. */
    openCovered,
    openTotal,
    share: openTotal ? openCovered / openTotal : 0,
    jobs: all().length,
  };
}

/** For tests, and for a cold start on demand. */
export function clearCorpus() {
  corpus.clear();
}
