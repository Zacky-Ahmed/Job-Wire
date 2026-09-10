// pollerLease.js
//
// Exactly one process may crawl at a time.
//
// The guard against overlapping sweeps was `running`, a module-level
// boolean. That works for one process and means nothing across two: the
// moment this app runs on more than one replica — a rolling deploy is
// enough, since the old instance is still alive while the new one boots
// — both of them start crawling LinkedIn on the same schedule, from the
// same IP range, for the same queries. LinkedIn's answer to that is to
// stop answering, and the symptom is the one this project keeps having:
// no jobs, no error, indistinguishable from a quiet day.
//
// A lease is a row somebody holds for a while. Taking it is a conditional
// update — either the row is free, or its holder's lease has expired, or
// you already hold it — so two processes racing produce exactly one
// winner, decided by the database rather than by timing.
//
// The TTL is the important number. Too short and a long sweep loses its
// own lease mid-crawl while still holding the connections; too long and a
// process that dies takes the whole schedule down with it until the lease
// rots. A LinkedIn sweep is about eighty seconds, so the lease outlives a
// sweep several times over and is renewed on every tick.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

const LEASE_ID = "poller";

/** Long enough to outlive a slow sweep, short enough to recover quickly. */
export const LEASE_MS = 5 * 60_000;

/**
 * Take or renew the lease.
 *
 * One update, three acceptable cases, and the filter is what makes it
 * safe: the row does not exist, nobody holds it, the holder's lease has
 * expired, or the holder is us. Anything else matches nothing and the
 * update reports zero — which is this process being told, by the
 * database, that somebody else is crawling.
 */
export async function acquire(owner, { now = new Date(), ttlMs = LEASE_MS } = {}) {
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    const res = await collections.pollerState().updateOne(
      {
        _id: LEASE_ID,
        $or: [
          { leaseOwner: { $exists: false } },
          { leaseOwner: null },
          { leaseOwner: owner },
          { leaseExpiresAt: { $lt: now } },
        ],
      },
      { $set: { leaseOwner: owner, leaseExpiresAt: expiresAt, leaseTakenAt: now } },
      { upsert: true }
    );
    return res.matchedCount > 0 || res.upsertedCount > 0;
  } catch (err) {
    /* A duplicate key here means another process upserted the same row
       between our filter and our write. That is the race working: they
       won, we did not, and we crawl nothing this tick. */
    if (err?.code === 11000) return false;
    throw err;
  }
}

/**
 * Give it up, so the next process does not have to wait out the TTL.
 *
 * Only ever releases a lease we actually hold. Releasing unconditionally
 * would let a process that had already LOST its lease — because its own
 * sweep overran the TTL — hand the crawl away from whoever legitimately
 * took it over.
 */
export async function release(owner) {
  const res = await collections.pollerState().updateOne(
    { _id: LEASE_ID, leaseOwner: owner },
    { $set: { leaseOwner: null, leaseExpiresAt: null } }
  );
  return res.modifiedCount > 0;
}

/** Who holds it, for the admin page and for diagnosing a quiet poller. */
export async function current() {
  const row = await collections.pollerState().findOne(
    { _id: LEASE_ID },
    { projection: { leaseOwner: 1, leaseExpiresAt: 1, leaseTakenAt: 1 } }
  );
  if (!row?.leaseOwner) return null;
  return {
    owner: row.leaseOwner,
    expiresAt: row.leaseExpiresAt,
    takenAt: row.leaseTakenAt,
    expired: row.leaseExpiresAt ? row.leaseExpiresAt < new Date() : true,
  };
}

/** For tests, and for an operator who knows the holder is gone. */
export async function forceRelease() {
  log.warn("poller lease force-released");
  await collections.pollerState().updateOne(
    { _id: LEASE_ID },
    { $set: { leaseOwner: null, leaseExpiresAt: null } }
  );
}
