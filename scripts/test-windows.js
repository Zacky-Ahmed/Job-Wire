// test-windows.js
//
// Guards against the class of bug that made every sweep silently return
// nothing: asking LinkedIn for a time window it does not actually honour.
//
// A window is BROKEN if a wider window finds jobs that are inside the
// narrower window's range but the narrower window returns none. Run this
// whenever catches stop arriving for no obvious reason.
//
// Run:  npm run test-windows

import { fetchLinkedIn } from "../src/services/linkedin/fetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";
import { tprFor } from "../src/services/linkedin/buildUrl.js";

const BASE =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
  "?keywords=Intern&location=Sri%20Lanka&geoId=100446352&start=0&sortBy=DD";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);

const results = {};
console.log("\nProbing each window against live LinkedIn…\n");

for (const secs of [3600, 7200, 14400, 86400]) {
  const html = await fetchLinkedIn(`${BASE}&f_TPR=r${secs}`, { jitter: false });
  const shape = classifyResponse(html);
  const jobs = shape === "jobs" ? parseJobs(html) : [];
  results[secs] = jobs;
  console.log(
    `  r${String(secs).padEnd(6)} ${String(html.length).padStart(6)}B  ` +
    `${shape.padEnd(13)}${String(jobs.length).padStart(2)} jobs   ` +
    (jobs[0]?.postedText ?? "")
  );
  await sleep(1500);
}

console.log("\n── windows actually in use ──");
const used = [...new Set([2, 5, 15, 30, 60].map(tprFor))];
console.log("  tprFor() can return: " + used.map((w) => "r" + w).join(", "));
ok(!used.includes(3600), "r3600 is NOT used (LinkedIn returns empty for it)");

console.log("\n── each window in use returns data ──");
for (const w of used) {
  ok(results[w] && results[w].length > 0,
     `r${w} returned ${results[w]?.length ?? 0} jobs`);
}

console.log("\n── narrower windows are subsets, not empties ──");
// If a wide window has recent jobs, a narrower one must not be empty.
const wide = results[86400] ?? [];
const recent = wide.filter((j) => /minute|1 hour|2 hours/.test(j.postedText || ""));
if (recent.length) {
  ok((results[7200] ?? []).length > 0,
     `r7200 is non-empty while r86400 shows ${recent.length} very recent job(s)`);
} else {
  console.log("  SKIP  nothing posted in the last ~2h right now — inconclusive");
}
console.log("");
