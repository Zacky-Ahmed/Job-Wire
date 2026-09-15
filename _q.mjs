import "./src/config/env.js";
import { connectDb, collections } from "./src/config/db.js";
await connectDb();
const rows = await collections.seenJobs()
  .find({ title: /supply chain/i }).sort({ firstSeenAt: -1 }).limit(5).toArray();
for (const j of rows) {
  console.log("---");
  console.log("title      ", j.title);
  console.log("jobId      ", j.jobId);
  console.log("postedAt   ", j.postedAt ? j.postedAt.toISOString() : "(none)");
  console.log("firstSeenAt", j.firstSeenAt?.toISOString());
  if (j.postedAt && j.firstSeenAt)
    console.log("ageAtFind  ", Math.round((j.firstSeenAt - j.postedAt) / 60000), "min");
  console.log("queryId    ", String(j.queryId));
  console.log("notified   ", j.notified, " alertedAt:", j.alertedAt || "-");
  console.log("keys       ", Object.keys(j).join(","));
}
console.log("\n=== recent keells jobs ===");
const k = await collections.seenJobs().find({ jobId: /^keells:/ })
  .sort({ firstSeenAt: -1 }).limit(8).toArray();
for (const j of k) console.log(
  (j.firstSeenAt?.toISOString().slice(5,16) || "?"),
  String(j.title).slice(0,34).padEnd(36),
  "posted:" + (j.postedAt ? j.postedAt.toISOString().slice(5,16) : "none"),
  "notified:" + j.notified);
process.exit(0);
