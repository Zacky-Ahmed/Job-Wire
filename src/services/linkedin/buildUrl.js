// buildUrl.js
//
// Turns a query row into a LinkedIn search URL.
//
// f_TPR is the "posted within" filter, in seconds. It must comfortably
// EXCEED the sweep gap: if you sweep every 30 minutes with a 30-minute
// window, a job posted one minute after a sweep has aged out before the
// next one runs and you never see it. 4x the gap is the safety margin.

import { findGeo } from "./geoIds.js";

// MEASURED, not assumed. r3600 is UNRELIABLE on the guest endpoint —
// it intermittently returns a 26-byte empty document even when matching
// jobs exist. Two probes minutes apart, live, 2026-08-13:
//
//   probe A   r3600    26B   0 jobs   <- empty, while...
//             r7200  3113B   1 job       ...the same job showed here
//   probe B   r3600  3117B   1 job    <- worked this time
//
// It is not consistently broken, it is flaky, which is worse: the poller
// swept 12 times in an hour and got nothing every time. 7200 (2h) is the
// floor because a window that silently returns empty makes the whole
// product silently do nothing. Re-check with `npm run test-windows` if
// catches ever stop arriving.
const WINDOWS = [7200, 14400, 86400]; // 2h, 4h, 24h
const MIN_WINDOW = 7200;

export function tprFor(sweepMinutes) {
  const needed = sweepMinutes * 60 * 4;
  return WINDOWS.find((w) => needed <= w) ?? 86400;
}

export { MIN_WINDOW };

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

/** Canonical key so identical searches from different users share one row. */
export function canonicalKey(keywords) {
  return (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
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
