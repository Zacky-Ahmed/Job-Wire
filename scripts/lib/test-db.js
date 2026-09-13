// test-db.js
//
// Import this FIRST, before anything that reads src/config/env.js.
//
// Until now every suite in this directory connected to whatever
// MONGODB_URI pointed at, which in practice is the production Atlas
// cluster. e2e cleans up after itself, but an aborted run does not, and
// aborted runs have left real rows behind more than once: four stray
// accounts and a duplicate query on one occasion, and — worse — a
// match-all watch that the production poller then swept, which flooded
// real inboxes.
//
// ONE DATABASE PER RUN, and that is not tidiness either.
//
// Every run used to share `jobwire_test`, so two runs at once destroyed
// each other: the second one's reset wiped the first one's seeded user
// mid-flight, and the first then failed with a watch that would not
// create and a user row that had vanished. That is indistinguishable
// from a logic regression, and it cost a real debugging detour —
// `Queries.upsert` was suspected, and it was innocent.
//
// A test harness that can lie to the person changing the code is worse
// than a slow one. So each run gets its own database, named after a run
// id, and drops it at the end. Concurrent runs cannot see each other at
// all.
//
// Nothing in scripts/ may touch the production database.

import { randomBytes } from "node:crypto";

const PRODUCTION_DB = "jobwire";
const TEST_PREFIX = "jobwire_test";

/* Short, readable, and unique enough: this only has to distinguish runs
   that overlap on one machine, not survive a birthday attack. */
export const RUN_ID = process.env.TEST_RUN_ID || randomBytes(3).toString("hex");

/* Set before env.js is evaluated. ESM runs a module's imports depth
   first in source order, so this file being the first import of a suite
   is what makes the assignment land in time. Put it second and env.js
   has already read process.env and frozen the answer. */
if (!process.env.MONGODB_DB) process.env.MONGODB_DB = `${TEST_PREFIX}_${RUN_ID}`;
/* Handed to child processes — the test server has to join the same
   database, and inheriting the parent's env is how it learns which. */
process.env.TEST_RUN_ID = RUN_ID;

export const TEST_DB = process.env.MONGODB_DB;

if (TEST_DB === PRODUCTION_DB && process.env.ALLOW_PROD_TESTS !== "1") {
  console.error(
    `\nRefusing to run: MONGODB_DB is "${PRODUCTION_DB}", which is production.\n` +
    `These suites create, mutate and delete rows.\n\n` +
    `  unset MONGODB_DB          # a per-run database is created automatically\n` +
    `  ALLOW_PROD_TESTS=1 ...    # only if you genuinely mean it\n`
  );
  process.exit(1);
}

const { connectDb, getDb, closeDb, collections } = await import("../../src/config/db.js");

export { connectDb, getDb, closeDb, collections };

/**
 * What this run is, printed before anything else happens.
 *
 * When a failure turns up in a log three days later, "which database,
 * which commit, was mail real, was the poller on" are the first four
 * questions and none of them used to be answerable from the output.
 */
export async function announce(extra = {}) {
  let commit = "unknown";
  try {
    const { execSync } = await import("node:child_process");
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch { /* not a git checkout, or git is missing */ }

  const lines = {
    runId: RUN_ID,
    database: TEST_DB,
    commit,
    poller: process.env.POLLER_ENABLED === "true" ? "ON" : "OFF",
    mail: process.env.MAIL_ENABLED === "true" ? "REAL" : "DISABLED",
    ...extra,
  };
  console.log("\nJOB WIRE E2E\n" + "─".repeat(40));
  for (const [k, v] of Object.entries(lines)) {
    console.log(`${k.padEnd(12)}${v}`);
  }
  console.log("─".repeat(40) + "\n");
  return lines;
}

/**
 * Empty this run's database.
 *
 * Deletes documents rather than dropping collections, so the indexes
 * ensureIndexes() built survive between phases — several of the rules
 * being tested (the ledger's uniqueness, the subscription duplicate
 * guard) ARE indexes, and a suite that silently ran without them would
 * pass while proving nothing.
 *
 * Only ever touches THIS run's database, which is why a second run can
 * no longer pull the floor out from under the first.
 */
export async function resetTestDb() {
  if (TEST_DB === PRODUCTION_DB) throw new Error("resetTestDb refused: that is production");
  const db = getDb();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  for (const name of names) {
    if (name.startsWith("system.")) continue;
    await db.collection(name).deleteMany({});
  }
  return names;
}

/**
 * Drop this run's database entirely.
 *
 * Called at the end, so the cluster does not accumulate one database per
 * run forever. Failing here is not worth failing a green suite over —
 * the name carries the run id, so a leftover is identifiable and
 * droppable by hand.
 */
export async function dropTestDb() {
  if (TEST_DB === PRODUCTION_DB) throw new Error("dropTestDb refused: that is production");
  if (!TEST_DB.startsWith(TEST_PREFIX)) {
    throw new Error(`dropTestDb refused: "${TEST_DB}" is not a ${TEST_PREFIX}_* database`);
  }
  try {
    await getDb().dropDatabase();
    return true;
  } catch (err) {
    console.warn(`could not drop ${TEST_DB}: ${err.message} — drop it by hand`);
    return false;
  }
}

/**
 * Databases left behind by runs that were killed before they could drop
 * their own. Reported rather than deleted: a run that is still going has
 * a database that looks exactly like an abandoned one.
 */
export async function strayTestDatabases() {
  const admin = getDb().admin();
  const { databases } = await admin.listDatabases({ nameOnly: true });
  return databases
    .map((d) => d.name)
    .filter((n) => n.startsWith(`${TEST_PREFIX}_`) && n !== TEST_DB);
}
