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
// The delivery work this precedes needs tests that kill a process
// halfway through sending, so "usually cleans up" stops being good
// enough. Nothing in scripts/ may touch the production database again
// without saying so out loud.

const PRODUCTION_DB = "jobwire";
const DEFAULT_TEST_DB = "jobwire_test";

/* Set before env.js is evaluated. ESM runs a module's imports depth
   first in source order, so this file being the first import of a suite
   is what makes the assignment land in time. Put it second and env.js
   has already read process.env and frozen the answer. */
if (!process.env.MONGODB_DB) process.env.MONGODB_DB = DEFAULT_TEST_DB;

export const TEST_DB = process.env.MONGODB_DB;

if (TEST_DB === PRODUCTION_DB && process.env.ALLOW_PROD_TESTS !== "1") {
  console.error(
    `\nRefusing to run: MONGODB_DB is "${PRODUCTION_DB}", which is production.\n` +
    `These suites create, mutate and delete rows.\n\n` +
    `  unset MONGODB_DB          # or set it to ${DEFAULT_TEST_DB}\n` +
    `  ALLOW_PROD_TESTS=1 ...    # only if you genuinely mean it\n`
  );
  process.exit(1);
}

const { connectDb, getDb, closeDb, collections } = await import("../../src/config/db.js");

export { connectDb, getDb, closeDb, collections };

/**
 * Empty the test database.
 *
 * Deletes documents rather than dropping collections, so the indexes
 * ensureIndexes() built survive between suites — several of the rules
 * being tested (the ledger's uniqueness, the subscription duplicate
 * guard) ARE indexes, and a suite that silently ran without them would
 * pass while proving nothing.
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
