// indexes.js
//
// Creates every index at boot. createIndex is idempotent, so this is
// safe to run on every start.
//
// Two of these are load-bearing, not optimisations:
//   · seenJobs (queryId, jobId) unique — makes the dedupe safe when two
//     sweeps of the same query overlap. Without it, a race inserts the
//     same job twice and the user gets a duplicate email.
//   · seenJobs TTL — without it the collection grows forever and a
//     512 MB Atlas tier fills up.

import { collections } from "../config/db.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

/* createIndex, but tolerant of one that already exists under the same name
   with different options.
 *
 * Mongo answers that with IndexOptionsConflict (85), or IndexKeySpecsConflict
 * (86) when the key itself moved — it does not adopt the new options. And
 * this runs at boot, so a change as ordinary as raising a TTL or renaming a
 * field turns into a container that throws before it can bind a port, which
 * reads as "healthcheck failed" and nothing else. Raising ALERT_TTL_DAYS from
 * 730 to 1095 did exactly that and had to be repaired by hand against the
 * live database.
 *
 * Dropping and recreating is safe for every index here: they are small, they
 * rebuild in milliseconds, and the alternative is a failed deploy each time
 * an option changes.
 */
async function idx(coll, key, opts) {
  try {
    return await coll.createIndex(key, opts);
  } catch (err) {
    if (err?.code !== 85 && err?.code !== 86) throw err;
    log.warn("index definition changed — rebuilding", {
      name: opts?.name, code: err.code,
    });
    await coll.dropIndex(opts.name).catch(() => {});
    return coll.createIndex(key, opts);
  }
}

export async function ensureIndexes() {
  const created = [];

  // ── users ────────────────────────────────────────────────────
  created.push(
    await idx(collections.users(), { email: 1 }, { unique: true, name: "email_unique" })
  );

  // ── queries: canonical searches, shared across users ──────────
  // One fetch serves every subscriber of the same keywords+geo.
  created.push(
    await idx(collections.queries(), 
      { keywordsKey: 1, geoId: 1 },
      { unique: true, name: "query_canonical_unique" }
    )
  );
  // How upsert() decides a new watch is the same search as an existing
  // one. NOT unique: rows that predate it can already collide, and a
  // unique index would make every such signup fail with a duplicate-key
  // error instead of joining the row it found. Admin merges the leftovers.
  created.push(
    await idx(collections.queries(), { identityKey: 1 }, { name: "query_identity" })
  );
  // The poller's hot path: "which queries are due?"
  created.push(
    await idx(collections.queries(), { nextFetchAt: 1 }, { name: "due_scan" })
  );

  // ── alertedJobs: what has been MAILED, not merely shown ───────
  // Unique on the same pair as seenJobs, so a racing double-send is a
  // duplicate-key error rather than a second email.
  created.push(
    await idx(collections.alertedJobs(), 
      { queryId: 1, jobId: 1 },
      { unique: true, name: "alerted_unique" }
    )
  );
  /* Named for the field it indexes. The first version of this pointed at
     sentAt while the ledger had already been changed to write seenAt, so
     the TTL matched nothing and the collection would have grown for ever
     without ever expiring a row. Renaming the index alongside the field is
     what makes that impossible to repeat quietly. */
  created.push(
    await idx(collections.alertedJobs(), 
      { seenAt: 1 },
      { expireAfterSeconds: env.alertTtlDays * 86400, name: "ledger_ttl" }
    )
  );

  // ── subscriptions: user ↔ query ───────────────────────────────
  created.push(
    await idx(collections.subscriptions(), 
      { userId: 1, queryId: 1 },
      { unique: true, name: "no_duplicate_subscription" }
    )
  );
  // Fan-out on a catch: "who is subscribed to this query?"
  created.push(
    await idx(collections.subscriptions(), 
      { queryId: 1, active: 1 },
      { name: "fanout" }
    )
  );

  // ── seenJobs: the set we subtract against ─────────────────────
  created.push(
    await idx(collections.seenJobs(), 
      { queryId: 1, jobId: 1 },
      { unique: true, name: "seen_unique" }
    )
  );
  created.push(
    await idx(collections.seenJobs(), 
      { firstSeenAt: 1 },
      { expireAfterSeconds: env.seenJobTtlDays * 86400, name: "seen_ttl" }
    )
  );

  // ── emailLog ─────────────────────────────────────────────────
  created.push(
    await idx(collections.emailLog(), 
      { userId: 1, sentAt: -1 },
      { name: "user_recent" }
    )
  );
  /* Everything that reads emailLog WITHOUT a userId: the admin page's
     two daily counts, its "last accepted" lookup, and the retry pass
     scanning for failed and stalled rows. user_recent cannot serve any
     of them — its leading field is absent from every one of those
     filters — so all four were collection scans, over a table that only
     ever grows, on a page loaded after every admin action and on a
     query the poller runs every single tick.

     One index, not two. status is an equality match in all four and
     sentAt is the range and the sort in three, so status-then-sentAt is
     the right order for each of them. An index led by sentAt would
     serve nothing this one does not, and every send would pay to keep
     it. */
  created.push(
    await idx(collections.emailLog(), 
      { status: 1, sentAt: 1 },
      { name: "status_recent" }
    )
  );

  log.info("indexes ensured", { count: created.length, ttlDays: env.seenJobTtlDays });
  return created;
}
