// prune-matches.js
//
//   npm run prune-matches          -- report only
//   npm run prune-matches -- --apply
//
// Two matching rules changed, and history does not fix itself. Rows kept
// under the old rules are still on the wire and still being counted:
//
//   · matched on the DESCRIPTION only — a Senior Google Ads Specialist
//     and a Junior Estimator, kept because their body prose happened to
//     say "intern" somewhere
//   · LinkedIn jobs OUTSIDE the watch's country — LinkedIn's own country
//     filter leaks, so a Sri Lanka watch collected Lander WY and
//     Niagara Falls NY
//   · titles that matched only through the intern/trainee synonym, which
//     no longer exists — Trainee Barista, Trainee Commi (Pastry & Bakery),
//     Trainee Bar Waiters, CCTV Installation Trainees, Management Trainees
//
// These are marked unmatched, NOT deleted. The row is what remembers we
// already considered this job; deleting it would make the next sweep
// treat every one as brand new and email the whole pile.

import "../src/config/env.js";
import { connectDb, collections } from "../src/config/db.js";
import { findGeo } from "../src/services/linkedin/geoIds.js";
import { matchesAny } from "../src/utils/match.js";

const APPLY = process.argv.includes("--apply");
await connectDb();

const queries = await collections.queries().find({}).toArray();
const country = new Map(
  queries.map((q) => [String(q._id), (findGeo(q.geoId)?.name || "").toLowerCase()])
);
const words = new Map(queries.map((q) => [String(q._id), q.keywords || []]));
/* A match-all watch means "every job in this country", so its keywords
   describe nothing and matching against them is meaningless — sweep.js
   passes [] for exactly this reason. Without this the title rule below
   unmatched 1,594 of one watch's 1,625 rows: every one of them a correct
   match, discarded for failing a test that was never applied to them. */
const everything = new Set(
  queries.filter((q) => q.matchAll).map((q) => String(q._id))
);

// $ne:false, not true — legacy rows have no `matched` field at all, and
// every read in the app counts those as matched. Querying matched:true
// would quietly skip exactly the oldest rows this is meant to clean.
const rows = await collections.seenJobs().find({ matched: { $ne: false } }).toArray();

const doomed = [];
const rescued = [];
for (const r of rows) {
  const key = String(r.queryId);

  // Country first: it does not matter how well a Niagara Falls job
  // matches, it is not in Sri Lanka.
  if (String(r.jobId || "").startsWith("linkedin:")) {
    const want = country.get(key);
    const loc = (r.location || "").toLowerCase();
    if (want && loc && !loc.includes(want)) { doomed.push([r, "outside the country"]); continue; }
  }

  /* Kept because the TITLE matched, under a rule that has since changed.
     "intern" no longer means "trainee", so Trainee Barista and Management
     Trainees — perfectly good title matches while the synonym table
     existed — are not internships and do not belong on an intern watch.

     Asked against the CURRENT rule rather than by looking for the word
     "trainee": whatever the matcher does today is the definition, so this
     stays correct the next time it changes and needs no list of its own. */
  /* Only rows belonging to a watch that still exists can be judged.
     seenJobs outlives its query — the wire's TTL is the only thing that
     removes these — so an orphan row has no keywords to be tested
     against, `words.get` returns undefined, and every one of them fails
     a test nobody set. That accounted for 5,559 of the first run's 5,668.
     They are invisible anyway: nothing renders a row whose query is gone. */
  if (!words.has(key)) continue;

  if (!everything.has(key) &&
      r.matchedBy === "title" && !matchesAny(r.title, words.get(key) || [])) {
    doomed.push([r, "title no longer matches"]);
    continue;
  }

  /* A tag label is supposed to BE the value that matched ("Internship").
     "Cabin crew trainee" was on the wire labelled "Full-time", which no
     keyword search for "intern" could ever have produced — a leftover
     from when every tag match was labelled with the employment type even
     when it was the SENIORITY that hit. The match is real; the label is
     a lie, so re-derive it below rather than trusting it. */
  const META = ["title", "keyword", "description", "unverified", null, undefined];
  const staleTag =
    !META.includes(r.matchedBy) && !matchesAny(r.matchedBy, words.get(key) || []);

  if (r.matchedBy !== "description" && !staleTag) continue;

  /* Do NOT trust the old label. These rows were written before titles
     were matched on word boundaries and before "intern" was taught to
     mean "trainee", so a real "Management Trainee - International Sales"
     is sitting here labelled description-only. Re-ask the CURRENT rule:
     if the title matches today, the row was mislabelled, not wrong, and
     it keeps its place on the wire with an honest label. */
  if (matchesAny(r.title, words.get(key) || [])) rescued.push(r);
  else if (!staleTag) doomed.push([r, "description only"]);
}

console.log(`matched rows                 : ${rows.length}`);
console.log(`  description only           : ${doomed.filter((d) => d[1] === "description only").length}`);
console.log(`  outside the country        : ${doomed.filter((d) => d[1] === "outside the country").length}`);
console.log(`  title no longer matches    : ${doomed.filter((d) => d[1] === "title no longer matches").length}`);
console.log(`  to unmatch                 : ${doomed.length}`);
console.log(`  mislabelled, actually title: ${rescued.length}  (kept, relabelled)`);
if (rescued.length) {
  console.log();
  console.log("rescued — these DO match the title, the old label was wrong:");
  for (const r of rescued.slice(0, 8)) console.log(`   ${r.title}`);
}
if (doomed.length) {
  console.log("\nsample:");
  for (const [r, why] of doomed.slice(0, 10)) {
    console.log(
      `   ${(r.title || "").slice(0, 40).padEnd(42)}` +
      `${(r.location || "—").slice(0, 26).padEnd(28)}${why}`
    );
  }
}

if (!doomed.length && !rescued.length) {
  console.log();
  console.log("nothing to do.");
  process.exit(0);
}

if (APPLY) {
  let off = 0;
  if (doomed.length) {
    const res = await collections.seenJobs().updateMany(
      { _id: { $in: doomed.map(([r]) => r._id) } },
      { $set: { matched: false, unmatchedAt: new Date(), unmatchedBy: "prune-matches" } }
    );
    off = res.modifiedCount;
  }
  let fixed = 0;
  if (rescued.length) {
    // Keep them on the wire, but stop calling them description matches:
    // that tag now means "junk we let through", and these are not.
    const res = await collections.seenJobs().updateMany(
      { _id: { $in: rescued.map((r) => r._id) } },
      { $set: { matchedBy: "title" } }
    );
    fixed = res.modifiedCount;
  }
  console.log();
  console.log(`applied - ${off} rows off the wire, ${fixed} relabelled as title matches.`);
} else {
  console.log();
  console.log("dry run. re-run with -- --apply to write.");
}
process.exit(0);
