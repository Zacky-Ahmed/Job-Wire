// test-sweep.js
//
// Drives a real sweep against live LinkedIn without sending any mail,
// and proves the priming rule: sweep 1 stores everything and alerts on
// nothing; sweep 2 alerts only on genuinely new job ids.
//
// Run:  npm run test-sweep

import { connectDb, closeDb, collections } from "../src/config/db.js";
import { ensureIndexes } from "../src/models/indexes.js";
import * as Queries from "../src/models/queries.js";
import * as SeenJobs from "../src/models/seenJobs.js";
import { diff } from "../src/services/poller/dedupe.js";
import { buildGuestUrl, canonicalKey } from "../src/services/linkedin/buildUrl.js";
import { fetchLinkedIn } from "../src/services/linkedin/fetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";

const KEYWORDS = process.argv[2] ? process.argv[2].split(",") : ["Intern"];
const GEO = "100446352"; // Sri Lanka
const ok = (c, m) => console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);

await connectDb();
await ensureIndexes();

// Throwaway query row so this never touches a real user's watch.
const keywordsKey = "TEST::" + canonicalKey(KEYWORDS);
await collections.queries().deleteMany({ keywordsKey });
const query = await Queries.upsert({
  keywordsKey, keywords: KEYWORDS, geoId: GEO,
  location: "Sri Lanka", everyMinutes: 60,
});
await collections.seenJobs().deleteMany({ queryId: query._id });

const url = buildGuestUrl({ keywords: KEYWORDS, geoId: GEO, sweepMinutes: 60 });
console.log("\nGET " + url + "\n");

const t0 = Date.now();
const html = await fetchLinkedIn(url, { jitter: false });
const jobs = parseJobs(html);
console.log(`  fetched ${jobs.length} jobs in ${Date.now() - t0}ms (${html.length} bytes)`);
ok(classifyResponse(html) === "jobs", "response classified as jobs");
ok(jobs.length > 0, "parser found at least one job");
ok(jobs.every((j) => /^\d+$/.test(j.jobId)), "every job has a numeric id");
ok(jobs.every((j) => j.title && j.url), "every job has a title and url");

console.log("\n── sweep 1 (priming) ──");
let r = await diff({ ...query, primed: false }, jobs);
ok(r.alertable.length === 0, "priming sweep alerts on NOTHING");
ok(r.stored === jobs.length, `priming stored all ${jobs.length} jobs silently`);

console.log("\n── sweep 2 (same jobs, nothing new) ──");
r = await diff({ ...query, primed: true }, jobs);
ok(r.alertable.length === 0, "re-seeing the same jobs alerts on nothing");

console.log("\n── sweep 3 (one genuinely new job) ──");
const fake = { ...jobs[0], jobId: "999999" + Date.now().toString().slice(-6),
  title: "Simulated New Posting" };
r = await diff({ ...query, primed: true }, [...jobs, fake]);
ok(r.alertable.length === 1, "exactly one job is alertable");
ok(r.alertable[0]?.jobId === fake.jobId, "and it is the new one");

console.log("\n── concurrent sweep (race safety) ──");
const fake2 = { ...jobs[0], jobId: "888888" + Date.now().toString().slice(-6) };
const [a, b] = await Promise.all([
  diff({ ...query, primed: true }, [fake2]),
  diff({ ...query, primed: true }, [fake2]),
]);
ok(a.alertable.length + b.alertable.length === 1,
   "two overlapping sweeps produce ONE alert, not two");

const stored = await SeenJobs.countFor(query._id);
console.log(`\n  seenJobs rows for this query: ${stored}`);

await collections.seenJobs().deleteMany({ queryId: query._id });
await collections.queries().deleteMany({ keywordsKey });
console.log("  cleaned up test query\n");
await closeDb();
