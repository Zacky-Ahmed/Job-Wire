// backfill-alert-ledger.js
//
//   npm run backfill-alerts            -- report only
//   npm run backfill-alerts -- --apply
//
// Seeds the ledger with every job the wire currently remembers.
//
// Dedupe now asks the ledger "have we ever seen this?" instead of asking
// seenJobs, whose 14-day TTL made long-lived listings look new again. Until
// this runs the ledger does not know about anything discovered before it
// existed, so every job still sitting in seenJobs would be rediscovered and
// mailed once more the moment its wire row expired.
//
// seenJobs is the right source here, and emailLog is not. An earlier version
// of this script seeded from emailLog — what had been SENT — which left out
// every job the old day-precision rule had withheld. Those were exactly the
// ones that then flooded: 22 MAS listings in a single sweep, 18 of them over
// a fortnight old, five recipients each.
//
// Idempotent: the unique index absorbs a re-run.

import "../src/config/env.js";
import { connectDb, collections } from "../src/config/db.js";
import { ensureIndexes } from "../src/models/indexes.js";

const APPLY = process.argv.includes("--apply");
await connectDb();
if (APPLY) await ensureIndexes();

const pairs = new Map();
const cursor = collections.seenJobs()
  .find({}, { projection: { queryId: 1, jobId: 1, firstSeenAt: 1 } });
let rows = 0;
for await (const row of cursor) {
  rows++;
  if (!row.queryId || !row.jobId) continue;
  const key = `${row.queryId}::${row.jobId}`;
  if (!pairs.has(key)) {
    pairs.set(key, { queryId: row.queryId, jobId: row.jobId, seenAt: row.firstSeenAt || new Date() });
  }
}
console.log(`seenJobs rows read : ${rows}`);
console.log(`distinct query+job : ${pairs.size}`);

const bySource = new Map();
for (const { jobId } of pairs.values()) {
  const s = String(jobId).split(":")[0];
  bySource.set(s, (bySource.get(s) || 0) + 1);
}
for (const [s, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(s).padEnd(10)} ${n}`);
}

if (!APPLY) { console.log("\ndry run. re-run with -- --apply to write."); process.exit(0); }

const all = [...pairs.values()];
let written = 0, already = 0;
for (let i = 0; i < all.length; i += 500) {
  const slice = all.slice(i, i + 500);
  try {
    const res = await collections.alertedJobs().insertMany(slice, { ordered: false });
    written += res.insertedCount;
  } catch (err) {
    written += err.result?.insertedCount ?? 0;
    const we = err.writeErrors || [];
    already += we.length;
    if (we.some((e) => e.err?.code !== 11000)) throw err;
  }
}
console.log(`\nledger entries written : ${written}`);
console.log(`already present        : ${already}`);
console.log(`ledger total           : ${await collections.alertedJobs().countDocuments({})}`);
process.exit(0);
