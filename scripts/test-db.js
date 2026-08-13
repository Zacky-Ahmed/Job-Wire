// test-db.js
//
// Proves the Atlas connection works and creates every index.
// Run:  npm run test-db

import { connectDb, closeDb, getDb, collections } from "../src/config/db.js";
import { ensureIndexes } from "../src/models/indexes.js";
import { env } from "../src/config/env.js";

const started = Date.now();

try {
  console.log("→ connecting to Atlas…");
  await connectDb();
  console.log(`✓ connected in ${Date.now() - started}ms`);

  const admin = getDb().admin();
  const info = await admin.serverStatus().catch(() => null);
  if (info) console.log(`  server: MongoDB ${info.version} (${info.host})`);
  console.log(`  database: ${env.mongoDb}`);

  console.log("\n→ creating indexes…");
  await ensureIndexes();

  console.log("\n  collection      indexes");
  console.log("  ─────────────── ───────────────────────────────────────");
  for (const [name, get] of Object.entries(collections)) {
    if (name === "sessions") continue; // created by connect-mongo at runtime
    const ix = await get().indexes();
    console.log(`  ${name.padEnd(15)} ${ix.map((i) => i.name).join(", ")}`);
  }

  // Round-trip a document so we know writes work, not just reads.
  console.log("\n→ testing a write…");
  const probe = getDb().collection("_probe");
  const { insertedId } = await probe.insertOne({ at: new Date() });
  await probe.deleteOne({ _id: insertedId });
  await probe.drop().catch(() => {});
  console.log("✓ write and delete succeeded");

  console.log("\nAll good. The database is ready.");
} catch (err) {
  console.error("\n✗ " + err.message);
  if (/ENOTFOUND|querySrv/i.test(err.message))
    console.error("  → hostname is wrong. Copy the mongodb+srv:// string from Atlas > Connect > Drivers.");
  if (/Authentication failed|bad auth/i.test(err.message))
    console.error("  → wrong username or password, or the password needs percent-encoding.");
  if (/IP that isn't whitelisted|not allowed/i.test(err.message))
    console.error("  → add your IP under Atlas > Network Access.");
  if (/timed out|ServerSelection/i.test(err.message))
    console.error("  → cluster unreachable: check Network Access allows 0.0.0.0/0.");
  process.exitCode = 1;
} finally {
  await closeDb();
}
