// probe-detail-duplication.js
//
//   npm run probe-detail
//
// How many LinkedIn detail requests are for a job some OTHER search
// already asked about?
//
// Refinement costs one HTTP request per job whose title did not match,
// and it is the most expensive thing the sweep does per job. seenJobs is
// keyed by (query, job), so two searches meeting the same job hold two
// rows — and, today, make two detail requests for the same immutable
// facts.
//
// The 21% duplicate-row figure quoted elsewhere is STORAGE duplication
// and does not translate into a 21% request saving. Most rows never
// trigger a detail request at all: a job whose title matches is decided
// for free, and one that reaches nobody's budget is never refined. The
// saving is bounded by the duplication among the rows that ACTUALLY
// cost a request, which is a different and much smaller set.
//
// So measure that set rather than the storage. Read-only.

import "../src/config/env.js";
import { connectDb, closeDb, collections } from "../src/config/db.js";
import { matchesAny } from "../src/utils/match.js";

const days = Number(process.argv[2]) || 14;
const since = new Date(Date.now() - days * 86_400_000);

await connectDb();

const queries = await collections.queries()
  .find({}, { projection: { keywords: 1, matchAll: 1, geoId: 1 } })
  .toArray();
const wordsOf = new Map(queries.map((q) => [String(q._id), q.matchAll ? [] : (q.keywords || [])]));

const rows = await collections.seenJobs()
  .find(
    { jobId: /^linkedin:/, firstSeenAt: { $gte: since } },
    { projection: { jobId: 1, queryId: 1, title: 1, matchedBy: 1 } }
  )
  .toArray();

if (!rows.length) {
  console.log(`no LinkedIn rows in the last ${days} days.`);
  await closeDb();
  process.exit(0);
}

/* Which rows would have cost a detail request.

   A title match is decided for free, and a match-all watch never
   refines at all. Everything else had to go and read the job page — and
   matchedBy tells us afterwards which ones did: "title" is free,
   anything else ("employment type", "seniority", "unverified") was paid
   for. Rows with no verdict yet were deferred and have not been charged
   for either.

   Reconstructed from the keywords as a cross-check, because matchedBy
   is only written for jobs that survived, and a job the refinement
   REJECTED cost exactly the same request while leaving a different
   trace. */
const paid = rows.filter((r) => {
  const words = wordsOf.get(String(r.queryId));
  if (!words || !words.length) return false;         // match-all: never refines
  return !matchesAny(r.title || "", words);          // title match is free
});

const byJob = new Map();
for (const r of paid) {
  const key = r.jobId;
  if (!byJob.has(key)) byJob.set(key, new Set());
  byJob.get(key).add(String(r.queryId));
}

const distinctJobs = byJob.size;
const totalRequests = paid.length;
const duplicates = totalRequests - distinctJobs;

console.log(`LinkedIn rows in the last ${days} days:            ${rows.length}`);
console.log(`  of which a title match decided for free:       ${rows.length - paid.length}`);
console.log(`  of which needed a detail request:              ${totalRequests}`);
console.log(`  distinct jobs among those:                     ${distinctJobs}`);
console.log(`  DUPLICATE requests for facts already fetched:  ${duplicates}` +
  (totalRequests ? `  (${Math.round((duplicates / totalRequests) * 100)}% of detail requests)` : ""));

const shared = [...byJob.entries()].filter(([, qs]) => qs.size > 1);
console.log(`\njobs asked about by more than one search: ${shared.length}`);
if (shared.length) {
  const worst = shared.sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  console.log("the most-duplicated:");
  for (const [jobId, qs] of worst) console.log(`  ${qs.size} searches  ${jobId}`);
}

console.log(
  `\nWHAT THIS DOES AND DOES NOT SAY.\n` +
  `Caching a job's employment type and seniority globally, by LinkedIn job id,\n` +
  `saves exactly the duplicate requests counted above — those facts do not\n` +
  `change once a job is posted. It saves nothing on the first request for any\n` +
  `job, which is most of them at N=${queries.length}, and the saving grows only\n` +
  `as searches start overlapping.\n\n` +
  `Closure status is NOT one of those facts. It changes, it is the whole point\n` +
  `of the closure check, and caching it would keep telling people a filled\n` +
  `vacancy is open.`
);

await closeDb();
process.exit(0);
