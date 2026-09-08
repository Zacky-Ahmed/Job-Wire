// prime-new-sources.js
//
//   npm run prime-sources -- --sources itpro,xpress,rooster
//   npm run prime-sources -- --sources itpro,xpress,rooster --apply
//
// Absorbs a newly added source into watches that are already running.
//
// A query's FIRST sweep stores everything and alerts on nothing, because
// otherwise a new watch's first email is a wall of postings that have been
// up for weeks. Adding a source to an EXISTING watch has exactly the same
// shape and none of that protection: the watch is already primed, so the
// hundred jobs the new board has been carrying all along arrive at once
// and every one of them looks new.
//
// Measured before writing this: three new sources returned 91 matching
// jobs for the single word "intern". Two of them are day-precision, which
// means they skip the age gate by design, so nothing downstream would have
// held any of it back. That is ninety-one emails per subscriber.
//
// So this does what a priming sweep does. It records what the new sources
// are carrying right now — into the wire so the jobs are visible, and into
// the ledger so they can never be mailed as news — and leaves everything
// found afterwards to arrive normally.

import "../src/config/env.js";
import { connectDb, collections } from "../src/config/db.js";
import { SOURCES, sourcesForCountry } from "../src/services/sources/index.js";
import * as SeenJobs from "../src/models/seenJobs.js";
import * as Ledger from "../src/models/alertedJobs.js";
import { matchesAny } from "../src/utils/match.js";

const APPLY = process.argv.includes("--apply");
const arg = process.argv[process.argv.indexOf("--sources") + 1];
const WANTED = (arg && !arg.startsWith("--") ? arg : "").split(",").map((s) => s.trim()).filter(Boolean);
if (!WANTED.length) {
  console.error("name the sources: --sources itpro,xpress,rooster");
  process.exit(1);
}
const unknown = WANTED.filter((s) => !SOURCES[s]);
if (unknown.length) { console.error("unknown source(s):", unknown.join(", ")); process.exit(1); }

await connectDb();
const queries = await collections.queries().find({ nextFetchAt: { $type: "date" } }).toArray();
console.log(`live watches: ${queries.length}\n`);

let seeded = 0;
for (const q of queries) {
  const usable = WANTED.filter((s) => sourcesForCountry(q.geoId).includes(s));
  if (!usable.length) {
    console.log(`  ${String(q.keywordsKey).slice(0, 34).padEnd(36)} none of these cover ${q.location}`);
    continue;
  }

  const words = q.matchAll ? [] : (q.keywords || []);
  const found = [];
  for (const sid of usable) {
    try {
      const jobs = await SOURCES[sid].fetchJobs({
        keywords: q.keywords, geoId: q.geoId, matchAll: !!q.matchAll, page: 0,
      });
      const mine = jobs.filter((j) => !words.length || matchesAny(j.title, words));
      found.push(...mine);
      console.log(`  ${String(q.keywordsKey).slice(0, 24).padEnd(26)} ${sid.padEnd(9)} ${String(mine.length).padStart(4)} jobs`);
    } catch (err) {
      console.log(`  ${String(q.keywordsKey).slice(0, 24).padEnd(26)} ${sid.padEnd(9)} FAILED: ${err.message.slice(0, 50)}`);
    }
  }
  if (!found.length) continue;

  if (APPLY) {
    // Ledger first, for the same reason the sweep claims before sending:
    // if this dies halfway, the worst case is a job recorded as known and
    // never shown, not a job mailed twice.
    await Ledger.remember(q._id, found.map((j) => j.jobId));
    await SeenJobs.insertNew(q._id, found);
    await SeenJobs.markMatched(q._id, found.map((j) => ({ ...j, matchedBy: "title" })));
  }
  seeded += found.length;
}

console.log(`\njobs absorbed without alerting: ${seeded}`);
console.log(APPLY ? "applied." : "\ndry run. add --apply to write.");
process.exit(0);
