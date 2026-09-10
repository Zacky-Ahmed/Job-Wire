// analyse-linkedin-surfaces.js
//
//   npm run analyse-surfaces
//
// Does each LinkedIn surface earn the requests it costs?
//
// LinkedIn is read through three public surfaces, unioned:
//
//   F  the unfiltered country feed  — keyword-independent, shareable
//   G  the guest API keyword query  — keyword-dependent
//   J  the JSERP search page        — keyword-dependent
//
// Three surface walks per search is the single largest cost in the
// system, and dropping one takes LinkedIn from 3N walks to 2N
// immediately. The raw logs say JSERP contributes 1-8 extra jobs per
// sweep, and that number decides nothing at all:
//
//   · a job is not a match, and a match is not an alert;
//   · a job seen by both F and J is not a contribution from J;
//   · eight jobs nobody would ever have been emailed about are worth
//     exactly as much as zero.
//
// THE NUMBER THAT DECIDES is marginal actionable recall:
//
//   jobs that produced a real user match AND were visible only to S
//   ---------------------------------------------------------------
//        all jobs that produced a real user match
//
// This reads it off the provenance mask recorded on every LinkedIn job
// at discovery. It is a SHADOW experiment: all three surfaces keep being
// fetched, nothing is removed, and the question is answered from what
// actually happened rather than by switching a surface off and watching
// for complaints.
//
// IT NEEDS DAYS OF TRAFFIC. A surface that contributes one unique
// actionable match a week cannot be distinguished from one that
// contributes none by looking at an afternoon. Run it, note the sample
// size it reports, and do not act on a small one.
//
// Read-only.

import "../src/config/env.js";
import { connectDb, closeDb, collections } from "../src/config/db.js";

const days = Number(process.argv[2]) || 7;
const since = new Date(Date.now() - days * 86_400_000);

await connectDb();

const rows = await collections.seenJobs()
  .find(
    { jobId: /^linkedin:/, firstSeenAt: { $gte: since } },
    { projection: { jobId: 1, surfaces: 1, matched: 1, matchedBy: 1, queryId: 1 } }
  )
  .toArray();

if (!rows.length) {
  console.log(`no LinkedIn jobs recorded in the last ${days} days.`);
  console.log("Nothing to analyse — the provenance mask is written at discovery,");
  console.log("so this needs sweeps that happened AFTER it was added.");
  await closeDb();
  process.exit(0);
}

const withMask = rows.filter((r) => typeof r.surfaces === "string" && r.surfaces.length);
const unknown = rows.length - withMask.length;

console.log(`LinkedIn jobs seen in the last ${days} days: ${rows.length}`);
console.log(`  carrying a provenance mask: ${withMask.length}`);
if (unknown) {
  console.log(`  recorded before the mask existed: ${unknown} — excluded, not assumed`);
}
if (withMask.length < 200) {
  console.log(
    `\n*** ${withMask.length} masked jobs is a SMALL SAMPLE. ***\n` +
    `A surface contributing one unique actionable match a week cannot be told\n` +
    `apart from one contributing none at this size. Let it run longer.`
  );
}

/* "Actionable" means the job produced a real match for a real watch —
   not that it was fetched, and not that its title happened to contain a
   keyword. matched is what the sweep concluded after refinement, which
   is the closest thing to "somebody would have been told". */
const actionable = withMask.filter((r) => r.matched);

console.log(`\nof those, ${actionable.length} produced a real match (${pct(actionable.length, withMask.length)})`);

const tally = (list) => {
  const t = new Map();
  for (const r of list) t.set(r.surfaces, (t.get(r.surfaces) || 0) + 1);
  return [...t.entries()].sort((a, b) => b[1] - a[1]);
};

console.log("\n-- every job, by which surfaces saw it --");
for (const [mask, n] of tally(withMask)) {
  console.log(`  ${String(n).padStart(5)}  ${mask.padEnd(4)} ${describe(mask)}`);
}

console.log("\n-- ACTIONABLE jobs only, which is what decides this --");
for (const [mask, n] of tally(actionable)) {
  console.log(`  ${String(n).padStart(5)}  ${mask.padEnd(4)} ${describe(mask)}`);
}

console.log("\n-- marginal actionable recall, per surface --");
console.log("   what would have been LOST had this surface not been fetched\n");
for (const s of ["F", "G", "J"]) {
  const only = actionable.filter((r) => r.surfaces === s).length;
  const seenBy = actionable.filter((r) => r.surfaces.includes(s)).length;
  console.log(
    `  ${s} ${name(s).padEnd(20)} ` +
    `unique actionable: ${String(only).padStart(4)} (${pct(only, actionable.length)})   ` +
    `saw in total: ${String(seenBy).padStart(4)}`
  );
}

console.log(
  `\nA surface whose UNIQUE actionable contribution is near zero can be dropped:\n` +
  `everything it found, something cheaper found too. One with a real unique\n` +
  `share cannot, however small the raw job count beside it looks.\n` +
  `\nDropping one keyword-dependent surface takes LinkedIn from 3N surface walks\n` +
  `to 2N, and the whole system from 4 + 5N to 4 + 4N. That is the prize; the\n` +
  `numbers above are whether it is affordable.`
);

function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : "—"; }
function name(s) {
  return { F: "country feed", G: "guest keyword", J: "JSERP page" }[s] || s;
}
function describe(mask) {
  const parts = [...mask].map(name);
  return parts.length === 1 ? `${parts[0]} only` : parts.join(" + ");
}

await closeDb();
process.exit(0);
