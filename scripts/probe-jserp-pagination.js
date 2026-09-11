// probe-jserp-pagination.js
//
//   npm run probe-jserp
//
// Does the JSERP search page paginate at all?
//
// The latency trace turned up something odd: past page 2, every JSERP
// page reported "0 new" while still returning 22-42 rows. The obvious
// reading is that `start` is being ignored and we are asking for the
// same result set over and over.
//
// If that is true, JSERP is not a surface with a stale-page problem. It
// is a surface with ONE page, and the stale heuristic is only hiding
// that fact — we spend requests discovering the same thing every sweep
// instead of declaring maxPages = 1 and never asking again.
//
// Two runs of one keyword cannot establish that, which is why this
// compares job-id FINGERPRINTS across several pages, several keywords
// and whatever times you run it. Identical fingerprints at different
// `start` values are the proof; a single "0 new" is not.
//
// Read-only.

import "../src/config/env.js";
import { createHash } from "node:crypto";
import { guardedFetch } from "../src/services/http/guardedFetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";
import { pageUrlFor, urlFor } from "../src/services/sources/linkedin.js";

const GEO = "100446352";
const KEYWORDS = (process.argv[2] || "intern,software,accountant").split(",");
const PAGES = [0, 1, 2, 5, 10];
/* The adapter's own page size, so the printed start offsets are the ones
   actually requested. The first version of this printed page*25 as a
   label while the URL builder used page*pageSize — a cosmetic lie, but
   the kind that makes a reader mistrust the real numbers beside it. */
const PAGE_SIZE = (await import("../src/services/sources/linkedin.js")).pageSize;
const HOSTS = ["www.linkedin.com", "linkedin.com"];

const fingerprint = (ids) =>
  createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 10);

async function samplePage(build, keyword, page) {
  try {
    const html = await guardedFetch(build({ geoId: GEO, keywords: keyword, page }), HOSTS, { jitter: true });
    /* "jobs" is the good case, not "ok". Guessing that sentinel is why
       the first run of this probe reported zero rows on every page of
       both surfaces — it discarded every successful response. Read the
       classifier, do not assume its vocabulary. */
    const shape = classifyResponse(html);
    if (shape === "empty" || shape === "unrecognised") {
      return { page, shape, ids: [], fp: shape, n: 0 };
    }
    const jobs = parseJobs(html, new Date());
    const ids = jobs.map((j) => j.jobId);
    return { page, shape, ids, fp: fingerprint(ids), n: ids.length };
  } catch (err) {
    return { page, shape: "error", ids: [], fp: "error", error: err.message };
  }
}

/* Both surfaces, because the comparison is the point. The guest endpoint
   is known to paginate — it is where the country feed's 22 pages come
   from — so it is the control. If guest fingerprints change per page and
   JSERP's do not, the difference is real rather than a property of how
   this probe asks. */
for (const surface of [
  { name: "jserp (the suspect)", build: pageUrlFor },
  { name: "guest (the control)", build: urlFor },
]) {
  console.log(`\n${"=".repeat(64)}\n${surface.name}\n${"=".repeat(64)}`);

  for (const keyword of KEYWORDS) {
    const rows = [];
    for (const page of PAGES) rows.push(await samplePage(surface.build, keyword, page));

    const fps = rows.map((r) => r.fp);
    const distinct = new Set(fps.filter((f) => f && f !== "empty" && f !== "error"));
    const allSame = distinct.size === 1 && rows.filter((r) => r.n > 0).length > 1;

    console.log(`\n  "${keyword}"`);
    for (const r of rows) {
      console.log(
        `    page=${String(r.page).padStart(2)} (start=${String(r.page * PAGE_SIZE).padStart(4)})  ` +
        `${String(r.n ?? 0).padStart(3)} rows  ${r.fp}` +
        (r.error ? `  ${r.error.slice(0, 40)}` : "")
      );
    }
    console.log(
      allSame
        ? `    -> IDENTICAL at every start. This endpoint ignores the parameter.`
        : `    -> ${distinct.size} distinct result sets across ${rows.length} pages — it does paginate.`
    );
  }
}

console.log(
  `\n\nHOW TO READ THIS\n${"-".repeat(64)}\n` +
  `If JSERP's fingerprint is identical at start=0 and start=250 while the\n` +
  `guest control changes, the start parameter is being ignored and JSERP has exactly one\n` +
  `page of data. The fix is then maxPages = 1 — not a cleverer stop rule —\n` +
  `and every request past the first was always waste.\n\n` +
  `If the fingerprints DO differ, the "0 new" in the latency trace meant\n` +
  `something else (overlapping result sets, or a genuinely small corpus) and\n` +
  `the stale rule is doing real work. Do not change it on one observation.\n\n` +
  `Run this at different times of day before concluding. A quiet Sunday can\n` +
  `make a paginating endpoint look like a single-page one.`
);

process.exit(0);
