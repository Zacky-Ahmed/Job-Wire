// backfill-alert-ledger.js
//
//   npm run backfill-alerts            -- report only
//   npm run backfill-alerts -- --apply
//
// Seeds alertedJobs from the emails that actually went out.
//
// Day-precision sources used to be refused when their printed date was
// older than SEEN_JOB_TTL_DAYS. That rule is gone — it was suppressing
// real Keells listings — and alertedJobs replaces it. Until this runs the
// ledger is empty, which matters for exactly one case: a posting a board
// has left up for longer than the seenJobs window falls out of that
// memory, is rediscovered as new, and with nothing saying it was already
// mailed, goes out a second time.
//
// emailLog is the right source and seenJobs is not. seenJobs records what
// the WIRE showed, including the jobs the old date rule withheld — seeding
// from it would mark those as already-sent and bury the very listings this
// change exists to deliver.
//
// Only status:"sent" counts. A failed row means the mail did not arrive,
// so that job should still be eligible.
//
// The original send time is carried over rather than stamped as now, so
// the TTL expires on the real schedule.

import "../src/config/env.js";
import { connectDb, collections } from "../src/config/db.js";
import { ensureIndexes } from "../src/models/indexes.js";

const APPLY = process.argv.includes("--apply");
await connectDb();
if (APPLY) await ensureIndexes();

const cursor = collections.emailLog()
  .find({ status: "sent" }, { projection: { queryId: 1, jobIds: 1, sentAt: 1 } });

// Deduped in memory: one job mailed to five subscribers is five emailLog
// rows and one ledger entry, because the ledger is per SEARCH.
const pairs = new Map();
let rows = 0, withoutQuery = 0;
for await (const row of cursor) {
  rows++;
  if (!row.queryId) { withoutQuery++; continue; }
  for (const jobId of row.jobIds || []) {
    const key = `${row.queryId}::${jobId}`;
    const at = row.sentAt || new Date();
    // Earliest send wins, so the TTL counts from the first time it went out.
    if (!pairs.has(key) || at < pairs.get(key).sentAt) {
      pairs.set(key, { queryId: row.queryId, jobId, sentAt: at });
    }
  }
}

console.log(`emailLog rows read     : ${rows}`);
if (withoutQuery) console.log(`  (skipped, no queryId): ${withoutQuery}`);
console.log(`distinct query+job     : ${pairs.size}`);

const bySource = new Map();
for (const { jobId } of pairs.values()) {
  const s = String(jobId).split(":")[0];
  bySource.set(s, (bySource.get(s) || 0) + 1);
}
for (const [s, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(s).padEnd(10)} ${n}`);
}

if (!APPLY) {
  console.log("\ndry run. re-run with -- --apply to write.");
  process.exit(0);
}

// Chunked and unordered: duplicate keys are expected on a re-run and must
// not abandon the rest of the batch.
const all = [...pairs.values()];
let written = 0, already = 0;
for (let i = 0; i < all.length; i += 500) {
  const slice = all.slice(i, i + 500);
  try {
    const res = await collections.alertedJobs().insertMany(slice, { ordered: false });
    written += res.insertedCount;
  } catch (err) {
    written += err.result?.insertedCount ?? 0;
    already += (err.writeErrors || []).length;
    const other = (err.writeErrors || []).filter((e) => e.err?.code !== 11000);
    if (other.length) throw err;
  }
}
console.log(`\nledger entries written : ${written}`);
console.log(`already present        : ${already}`);
process.exit(0);
