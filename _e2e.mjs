import fs from "node:fs";
const p = "scripts/e2e.js";
let s = fs.readFileSync(p, "utf8");
const must = (o, n, l) => { if (!s.includes(o)) { console.error("MISS " + l); process.exit(1); } s = s.replace(o, n); };

must(
`// e2e.js
//
// Drives the SIGNED-IN pages against a running server.
// Start the server first, then:  npm run e2e
//
// Seeds a pre-verified user directly in Mongo
// so the run does not depend on reading a real inbox.
const { connectDb, collections, closeDb } = await import("../src/config/db.js");
const pw = await import("../src/services/auth/password.js");
const { canonicalKey } = await import("../src/services/linkedin/buildUrl.js");

const BASE = "http://localhost:3000";`,
`// e2e.js
//
// Drives the SIGNED-IN pages.  npm run e2e
//
// Owns its own server and its own database. It used to require you to
// have started one yourself and then talked to localhost:3000 on
// whatever MONGODB_URI pointed at — which is production. It cleaned up
// after itself, but an aborted run did not, and aborted runs left real
// rows behind more than once: four stray accounts on one occasion, and
// a match-all watch that the production poller then swept and flooded
// real inboxes with.
//
// test-db.js must be the FIRST import. It sets MONGODB_DB before
// env.js can read it, and refuses to run at all against production.
import { TEST_DB, connectDb, collections, closeDb, resetTestDb } from "./lib/test-db.js";
import { startTestServer } from "./lib/test-server.js";

const pw = await import("../src/services/auth/password.js");
const { canonicalKey } = await import("../src/services/linkedin/buildUrl.js");
const { ensureIndexes } = await import("../src/models/indexes.js");`, "head");

must(
`await connectDb();
await collections.users().insertOne({`,
`await connectDb();
/* Indexes first: several of the rules under test ARE indexes — the
   ledger's uniqueness, the duplicate-subscription guard — and a suite
   that ran without them would pass while proving nothing. */
await ensureIndexes();
await resetTestDb();
await ensureIndexes();
console.log("database:", TEST_DB);

const server = await startTestServer();
const BASE = server.base;
console.log("server:  ", BASE);

await collections.users().insertOne({`, "boot");

must(
`await closeDb();
console.log("\ncleaned up test data");`,
`/* The database is thrown away wholesale, so the careful per-row cleanup
   above is now belt and braces rather than the only thing standing
   between a failed run and production data. It is kept because it also
   asserts that the app leaves nothing dangling. */
await resetTestDb();
await server.stop();
await closeDb();
console.log("\ncleaned up test data");`, "teardown");

fs.writeFileSync(p, s);
console.log("ok");
