// probe-linkedin-latency.js
//
//   npm run probe-linkedin
//
// Where does a LinkedIn sweep actually spend its time, and does the
// stale-page stop rule hide jobs?
//
// The question behind this is a real complaint: a watch is set to five
// minutes, and a job shows up in the email twenty to thirty minutes
// after it is visible on linkedin.com. There are at least four different
// clocks inside that delay and only some of them are ours:
//
//   posted -> LinkedIn's own index has it          not ours
//   index  -> the PUBLIC guest surfaces expose it  not ours
//   exposed -> our crawl reaches the page it is on OURS
//   reached -> matched, queued, sent               OURS
//
// Guessing which one costs the twenty minutes is how you end up
// increasing request frequency against a lag that was never yours. So
// this measures rather than assumes, and it answers three specific
// questions:
//
//   1. what does one sweep's timeline actually look like, page by page;
//   2. how long does a job sitting on GUEST PAGE 1 wait before the crawl
//      even looks at it, given the country feed is walked first;
//   3. would the two-stale-pages stop rule have hidden a job that a
//      complete walk finds — and if so, how often and how far in.
//
// It is READ-ONLY and deliberately a shadow: it walks past the point the
// real crawler stops, so the miss rate can be measured without changing
// what the real crawler does to anybody's inbox.
//
// It costs up to 3 x MAX_PAGES requests. That is a lot for one run and
// the reason this is a script you invoke, not something on a timer.

import "../src/config/env.js";
import { guardedFetch } from "../src/services/http/guardedFetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";
import { matchesAny } from "../src/utils/match.js";
/* THE ADAPTER'S OWN URL BUILDERS, not a reconstruction.

   Hand-writing the endpoints here would measure a different request from
   the one the sweep makes — different f_TPR window, different page size
   — and the numbers would describe a crawler that does not exist. The
   topjobs coverage probe made exactly this mistake with a selector and
   reported zero vacancies in all 31 areas. */
import { urlFor, pageUrlFor } from "../src/services/sources/linkedin.js";

const GEO = process.argv[2] || "100446352";          // Sri Lanka
const KEYWORDS = (process.argv[3] || "intern").split(",");
const MAX_PAGES = Number(process.argv[4]) || 40;
const STALE_RULE = 2;                                 // what the real crawler uses
const HOSTS = ["www.linkedin.com", "linkedin.com"];
const QUERY = KEYWORDS.join(" ");

const url = {
  // Exactly what linkedin.fetchJobs walks, in the order it walks them.
  countryFeed: (p) => urlFor({ geoId: GEO, page: p }),
  guestKeyword: (p) => urlFor({ geoId: GEO, keywords: QUERY, page: p }),
  jserp: (p) => pageUrlFor({ geoId: GEO, keywords: QUERY, page: p }),
};

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";

/** Walk one surface to the real end, recording every page. */
async function walk(name) {
  const seen = new Map();          // jobId -> { page, atMs }
  const pages = [];
  let stale = 0;
  let staleStoppedAtPage = null;   // where the REAL crawler would have given up

  for (let page = 0; page < MAX_PAGES; page++) {
    const startedAt = Date.now();
    let html;
    try {
      html = await guardedFetch(url[name](page), HOSTS, { jitter: true });
    } catch (err) {
      pages.push({ page, error: err.message, ms: Date.now() - startedAt });
      console.log(`${at()}  ${name.padEnd(13)} p${String(page).padStart(2)}  REQUEST FAILED  ${err.message}`);
      break;
    }
    const ms = Date.now() - startedAt;

    const shape = classifyResponse(html);
    if (shape === "empty") {
      pages.push({ page, ms, stopReason: "empty" });
      console.log(`${at()}  ${name.padEnd(13)} p${String(page).padStart(2)}  ${String(ms).padStart(5)}ms  END OF FEED`);
      break;
    }
    if (shape === "unrecognised") {
      pages.push({ page, ms, stopReason: "unrecognised" });
      console.log(`${at()}  ${name.padEnd(13)} p${String(page).padStart(2)}  ${String(ms).padStart(5)}ms  UNRECOGNISED MARKUP`);
      break;
    }

    const jobs = parseJobs(html, new Date());
    const before = seen.size;
    for (const j of jobs) {
      if (!seen.has(j.jobId)) seen.set(j.jobId, { page, atMs: Date.now() - t0, job: j });
    }
    const fresh = seen.size - before;

    /* Where the REAL crawler would have stopped. Recorded rather than
       acted on — the whole point is to keep walking and find out what is
       past it. */
    stale = fresh === 0 ? stale + 1 : 0;
    if (stale >= STALE_RULE && staleStoppedAtPage === null) staleStoppedAtPage = page;

    const matching = jobs.filter((j) => matchesAny(j.title, KEYWORDS)).length;
    pages.push({ page, ms, returned: jobs.length, fresh, matching });
    console.log(
      `${at()}  ${name.padEnd(13)} p${String(page).padStart(2)}  ${String(ms).padStart(5)}ms  ` +
      `${String(jobs.length).padStart(3)} rows  ${String(fresh).padStart(3)} new  ` +
      `${String(matching).padStart(2)} match "${KEYWORDS.join("+")}"` +
      (staleStoppedAtPage === page ? "   <-- the real crawler stops HERE" : "") +
      (staleStoppedAtPage !== null && staleStoppedAtPage < page ? "   (past the stop)" : "")
    );

    if (jobs.length === 0) break;
  }

  return { name, seen, pages, staleStoppedAtPage };
}

console.log(`LinkedIn sweep trace — geo ${GEO}, keywords "${KEYWORDS.join("+")}", max ${MAX_PAGES} pages/surface`);
console.log(`Walking PAST the two-stale-page rule on purpose, to measure what it hides.\n`);

/* Surfaces in the order the real adapter walks them, one request at a
   time, so the elapsed clock is the one a real sweep experiences. */
const results = [];
for (const name of ["countryFeed", "guestKeyword", "jserp"]) {
  console.log(`\n--- ${name} ---`);
  results.push(await walk(name));
}

console.log(`\n\n================ WHAT THIS SWEEP COST ================\n`);
let elapsed = 0;
for (const r of results) {
  const reqs = r.pages.length;
  const ms = r.pages.reduce((n, p) => n + (p.ms || 0), 0);
  elapsed += ms;
  console.log(
    `${r.name.padEnd(13)} ${String(reqs).padStart(2)} requests  ${String(Math.round(ms / 1000)).padStart(3)}s  ` +
    `${String(r.seen.size).padStart(4)} jobs  ` +
    `stale rule would stop at page ${r.staleStoppedAtPage ?? "never"}`
  );
}
console.log(`\ntotal wall time: ${Math.round((Date.now() - t0) / 1000)}s`);

/* QUESTION 2: how long does a job on guest page 1 wait today?

   The country feed is walked to completion first, so a job sitting on
   the very first page of the guest surface is not even LOOKED AT until
   every country-feed request has finished. */
const feed = results.find((r) => r.name === "countryFeed");
const feedMs = feed.pages.reduce((n, p) => n + (p.ms || 0), 0);
const guest = results.find((r) => r.name === "guestKeyword");
const guestP1 = guest.pages[0];
console.log(
  `\nA job on GUEST PAGE 1 is not looked at until the country feed finishes:\n` +
  `  country feed takes    ${Math.round(feedMs / 1000)}s (${feed.pages.length} requests)\n` +
  `  guest page 1 then     ${guestP1?.ms ?? "-"}ms\n` +
  `  so it waits           ~${Math.round(feedMs / 1000)}s inside the crawl before we see it`
);

/* QUESTION 3: does the stale rule hide actionable jobs? */
console.log(`\n\n================ DOES THE STALE RULE HIDE JOBS? ================\n`);
let hiddenTotal = 0;
let hiddenMatching = 0;
for (const r of results) {
  if (r.staleStoppedAtPage === null) {
    console.log(`${r.name.padEnd(13)} the rule never fired — nothing hidden`);
    continue;
  }
  const past = [...r.seen.values()].filter((v) => v.page > r.staleStoppedAtPage);
  const pastMatching = past.filter((v) => matchesAny(v.job.title, KEYWORDS));
  hiddenTotal += past.length;
  hiddenMatching += pastMatching.length;
  console.log(
    `${r.name.padEnd(13)} stops at page ${r.staleStoppedAtPage}; ` +
    `${past.length} jobs exist beyond it, ${pastMatching.length} of them match "${KEYWORDS.join("+")}"`
  );
  for (const v of pastMatching.slice(0, 8)) {
    console.log(`                page ${String(v.page).padStart(2)}  ${v.job.title}  (${v.job.postedText || "?"})`);
  }
}

console.log(
  `\nACROSS ALL SURFACES: ${hiddenTotal} jobs and ${hiddenMatching} MATCHING jobs sit past ` +
  `the point the real crawler gives up.`
);
if (hiddenMatching > 0) {
  console.log(
    `\nThat is the answer to question 3. The stale-page rule assumes new jobs are\n` +
    `contiguous, and this file's own comment records the opposite — a Software\n` +
    `Engineer Intern posted 40 minutes earlier sat on page 19. A job past the stop\n` +
    `is not found this sweep; it is found whenever LinkedIn's ranking happens to\n` +
    `float it forward, which is exactly what a 20-30 minute delay looks like.`
  );
} else {
  console.log(
    `\nNothing matching is hidden in THIS run. One run is not a miss rate — the\n` +
    `ordering changes between sweeps, which is the whole problem. Run it repeatedly\n` +
    `before concluding the rule is safe.`
  );
}

/* Cross-surface: which surface found each matching job FIRST? This is
   the input to any decision about dropping a surface, and to deciding
   what a cheap frequent probe should actually probe. */
console.log(`\n\n================ WHICH SURFACE FINDS THE MATCHES ================\n`);
const firstBy = new Map();
for (const r of results) {
  for (const [jobId, v] of r.seen) {
    if (!matchesAny(v.job.title, KEYWORDS)) continue;
    const prev = firstBy.get(jobId);
    if (!prev || v.atMs < prev.atMs) firstBy.set(jobId, { ...v, surface: r.name });
  }
}
const bySurface = new Map();
for (const v of firstBy.values()) {
  const k = `${v.surface} p${v.page}`;
  bySurface.set(k, (bySurface.get(k) || 0) + 1);
}
console.log(`${firstBy.size} distinct matching jobs, first seen at:`);
for (const [where, n] of [...bySurface].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${where}`);
}

const onGuestP1 = [...firstBy.values()].filter((v) => v.surface === "guestKeyword" && v.page === 0).length;
if (onGuestP1) {
  console.log(
    `\n${onGuestP1} matching jobs were first found on GUEST PAGE 1 — every one of them\n` +
    `waited ~${Math.round(feedMs / 1000)}s behind the country feed for no reason a reader would accept.`
  );
}

process.exit(0);
