// seed-audit-account.js
//
//   node scripts/dev/seed-audit-account.js
//
// Creates the signed-in account npm run measure-routes uses to sample
// page timings. Kept because measure-routes is useless without it.
//
// It WRITES TO WHATEVER MONGODB_DB POINTS AT, on purpose — the point is
// to measure real pages against real data. It deletes and recreates only
// this one address.

import "../../src/config/env.js";
import { connectDb, collections } from "../../src/config/db.js";
import * as pw from "../../src/services/auth/password.js";
await connectDb();
const email = "ui-audit@example.invalid";
await collections.users().deleteMany({ email });
const u = await collections.users().insertOne({
  email, passHash: await pw.hash("uiauditpassword"), verified: true,
  createdAt: new Date(), verifiedAt: new Date(),
});
// Point it at the existing "intern" search so the wire has real rows.
const q = await collections.queries().findOne({ keywordsKey: "intern" });
await collections.subscriptions().insertOne({
  userId: u.insertedId, queryId: q._id, label: "Intern", active: true,
  createdAt: new Date(Date.now() - 14 * 86400000),
});
console.log("seeded", email, "on query", String(q._id));
process.exit(0);
