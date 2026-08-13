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

export async function ensureIndexes() {
  const created = [];

  // ── users ────────────────────────────────────────────────────
  created.push(
    await collections.users().createIndex({ email: 1 }, { unique: true, name: "email_unique" })
  );

  // ── queries: canonical searches, shared across users ──────────
  // One fetch serves every subscriber of the same keywords+geo.
  created.push(
    await collections.queries().createIndex(
      { keywordsKey: 1, geoId: 1 },
      { unique: true, name: "query_canonical_unique" }
    )
  );
  // The poller's hot path: "which queries are due?"
  created.push(
    await collections.queries().createIndex({ nextFetchAt: 1 }, { name: "due_scan" })
  );

  // ── subscriptions: user ↔ query ───────────────────────────────
  created.push(
    await collections.subscriptions().createIndex(
      { userId: 1, queryId: 1 },
      { unique: true, name: "no_duplicate_subscription" }
    )
  );
  // Fan-out on a catch: "who is subscribed to this query?"
  created.push(
    await collections.subscriptions().createIndex(
      { queryId: 1, active: 1 },
      { name: "fanout" }
    )
  );

  // ── seenJobs: the set we subtract against ─────────────────────
  created.push(
    await collections.seenJobs().createIndex(
      { queryId: 1, jobId: 1 },
      { unique: true, name: "seen_unique" }
    )
  );
  created.push(
    await collections.seenJobs().createIndex(
      { firstSeenAt: 1 },
      { expireAfterSeconds: env.seenJobTtlDays * 86400, name: "seen_ttl" }
    )
  );

  // ── emailLog ─────────────────────────────────────────────────
  created.push(
    await collections.emailLog().createIndex(
      { userId: 1, sentAt: -1 },
      { name: "user_recent" }
    )
  );

  log.info("indexes ensured", { count: created.length, ttlDays: env.seenJobTtlDays });
  return created;
}
