// buildUrl.js
//
// Turns a query row into a LinkedIn search URL.
//
// f_TPR is the "posted within" filter, in seconds. It must comfortably
// EXCEED the sweep gap: if you sweep every 30 minutes with a 30-minute
// window, a job posted one minute after a sweep has aged out before the
// next one runs and you never see it. 4x the gap is the safety margin.

import { findGeo } from "./geoIds.js";

// MEASURED, twice, against live LinkedIn — and the answer both times was
// that NARROW WINDOWS LIE.
//
//   2026-08-13  r3600 returned an empty document while r7200 showed a job
//               posted 23 minutes earlier.
//   2026-08-14  r7200 returned 2 jobs and omitted one posted 30 minutes
//               earlier; r14400 returned it; r86400 returned 27.
//
// The filter is not a reliable "posted within" — it silently drops recent
// postings, which is the worst possible failure here because it looks
// exactly like a quiet day.
//
// So we stop relying on it. The window was only ever an optimisation to
// keep responses small; correctness comes from deduplicating on jobId,
// which is unaffected by how much history we ask for. Asking for 24h
// costs ~30KB per sweep instead of ~3KB and cannot miss anything.
const WINDOW = 86400;

export function tprFor() {
  return WINDOW;
}

export { WINDOW as MIN_WINDOW };

export function buildSearchUrl({ keywords, geoId, sweepMinutes = 5, page = 0 }) {
  const geo = findGeo(geoId);
  if (!geo) throw new Error(`Unknown geoId: ${geoId}`);
  const kw = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).join(" ");
  if (!kw) throw new Error("At least one keyword is required");

  const p = new URLSearchParams({
    keywords: kw,
    location: geo.name,
    geoId: geo.geoId,
    f_TPR: "r" + tprFor(sweepMinutes),
    sortBy: "DD",          // date descending — newest first
    position: "1",
    pageNum: String(page),
  });
  return "https://www.linkedin.com/jobs/search?" + p.toString();
}

/**
 * Canonical key so identical searches from different users share one row.
 * The SOURCES are part of the identity: "intern on LinkedIn" and "intern
 * on LinkedIn + Keells" are different searches and must not collapse into
 * one query, or whoever saved second would silently get the other's set.
 */
export function canonicalKey(keywords, sources = []) {
  const kw = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  const src = [...sources].map(String).sort().join("+");
  return src ? `${kw}@@${src}` : kw;
}

/**
 * The guest endpoint. Returns a bare <li> list with no login and far
 * less HTML than the full search page, so it is the cheaper thing to
 * poll. Falls back to buildSearchUrl if this ever stops working.
 */
export function buildGuestUrl({ keywords, geoId, sweepMinutes = 5, start = 0 }) {
  const geo = findGeo(geoId);
  if (!geo) throw new Error(`Unknown geoId: ${geoId}`);
  const kw = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).join(" ");
  const p = new URLSearchParams({
    keywords: kw,
    location: geo.name,
    geoId: geo.geoId,
    f_TPR: "r" + tprFor(sweepMinutes),
    sortBy: "DD",
    start: String(start),
  });
  return "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" + p.toString();
}
