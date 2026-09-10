// backfill-watch-intervals.js
//
//   npm run backfill-intervals            # report only
//   npm run backfill-intervals -- --write # actually write
//
// Every subscription now records the sweep interval its owner asked for,
// and the shared query's cadence is recomputed as the minimum across
// whoever is still listening. Rows created before that field existed
// have no request on them, and a subscriber with no request cannot vote
// — so a search where every remaining watcher is silent keeps whatever
// the old ratchet last pushed it down to, which is the exact problem
// this was meant to fix.
//
// So every existing watch inherits its query's CURRENT interval as its
// request. That is a vote for "leave it as it is", which is the only
// honest reading of a preference nobody ever expressed. From then on the
// cadence can go back up when the person who wanted it fast leaves.
//
// Runs against whatever MONGODB_DB points at, deliberately — this is an
// operational script, not a test, and it is meant for production. It
// reports before it writes, and writes nothing without --write.

import "../src/config/env.js";
import { connectDb, closeDb, collections } from "../src/config/db.js";

const write = process.argv.includes("--write");

await connectDb();

const queries = await collections.queries()
  .find({}, { projection: { everyMinutes: 1 } })
  .toArray();
const intervalOf = new Map(queries.map((q) => [String(q._id), q.everyMinutes]));

const missing = await collections.subscriptions()
  .find({ requestedEveryMinutes: { $exists: false } })
  .toArray();

console.log(`subscriptions without a recorded interval: ${missing.length}`);

const byInterval = new Map();
const orphans = [];
for (const sub of missing) {
  const every = intervalOf.get(String(sub.queryId));
  if (!Number.isFinite(every)) { orphans.push(sub); continue; }
  byInterval.set(every, (byInterval.get(every) || 0) + 1);
}
for (const [every, n] of [...byInterval].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(n).padStart(4)} would inherit ${every} min`);
}
if (orphans.length) {
  // A subscription pointing at a query that no longer exists. Not this
  // script's job to clean up, but worth saying out loud rather than
  // silently skipping.
  console.log(`  ${orphans.length} point at a query that no longer exists — left alone`);
}

if (!write) {
  console.log("\nreport only. re-run with --write to apply.");
  await closeDb();
  process.exit(0);
}

let written = 0;
for (const sub of missing) {
  const every = intervalOf.get(String(sub.queryId));
  if (!Number.isFinite(every)) continue;
  await collections.subscriptions().updateOne(
    { _id: sub._id },
    { $set: { requestedEveryMinutes: every } }
  );
  written++;
}
console.log(`\nwrote ${written} intervals`);

await closeDb();
process.exit(0);
