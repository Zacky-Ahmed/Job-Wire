// pollerLease.js
//
// Exactly one process may crawl at a time, and it must keep proving it.
//
// The guard against overlapping sweeps was `running`, a module-level
// boolean. That works for one process and means nothing across two: a
// rolling deploy alone produces two, since the old instance is still
// alive while the new one boots. Both would crawl LinkedIn on the same
// schedule, for the same queries, from the same IP range. LinkedIn's
// answer to that is to stop answering, and the symptom is the one this
// project keeps having — no jobs, no error, indistinguishable from a
// quiet day.
//
// THE FIRST VERSION OF THIS FILE DID NOT ACTUALLY PREVENT THAT, and the
// arithmetic says why. It took the lease once, at the top of a tick,
// with a five-minute TTL. A tick sweeps up to ten queries serially and
// one LinkedIn search is 78-92 seconds, so a full tick runs thirteen to
// fifteen minutes. The lease expired around query four, a second process
// found it expired and took it, and both crawled — which is precisely
// the thing the lease exists to stop, arriving about two thirds of the
// way through every busy tick.
//
// Worse, the lease lived in the same Mongo document as the poller's
// heartbeat, and the heartbeat wrote leaseOwner unconditionally. So the
// process that had already LOST the lease would stamp its own name back
// over the winner's at the end of its tick. The mechanism did not merely
// fail to protect; it corrupted the record of who was in charge.
//
// Three things fix it, and all three are necessary:
//
//   RENEWAL. The holder renews while it works, roughly every TTL/3. A
//   lease is a statement about the near future, not about a whole tick.
//
//   FENCING. Each acquisition increments a token. A renewal is
//   conditional on still holding that exact token, so a process whose
//   lease was taken over cannot renew its way back in, and a slow write
//   from a deposed holder cannot land after the new one's.
//
//   SEPARATION. The lease is its own document. Heartbeats are runtime
//   telemetry and must not be able to write a field that decides
//   authority.
//
// And the rule that makes it worth anything:
//
//   A WORKER WITHOUT A VALID FENCED LEASE MAY NOT START ANOTHER FETCH.
//
// Losing the lease is not an error to log and continue past. It means
// another process is authoritative and this one must stop.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

const LEASE_ID = "poller.lease";

/* Long enough to outlive a single query's crawl with room to spare,
   short enough that a dead holder does not stop the world for long.
   It no longer has to cover a whole tick — that is what renewal is
   for, and expecting one TTL to span thirteen minutes of crawling was
   the original mistake. */
export const LEASE_MS = 5 * 60_000;

/* Renew at roughly a third of the TTL, so two consecutive renewals can
   fail — a Mongo blip, a long request — before the lease actually
   lapses. */
export const RENEW_EVERY_MS = Math.floor(LEASE_MS / 3);

/**
 * Take the lease, or fail.
 *
 * Returns a FENCE — { owner, token, expiresAt } — or null. The token is
 * the thing that matters: every later renewal and the release are
 * conditional on it, so a process that lost the lease and did not
 * notice cannot write anything the new holder will see.
 *
 * $inc on a missing field starts it at the increment, so the first
 * acquisition gets token 1 without needing a seed document.
 */
export async function acquire(owner, { now = new Date(), ttlMs = LEASE_MS } = {}) {
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    const row = await collections.pollerLease().findOneAndUpdate(
      {
        _id: LEASE_ID,
        $or: [
          { owner: { $exists: false } },
          { owner: null },
          { expiresAt: { $lt: now } },
        ],
      },
      {
        $set: { owner, expiresAt, takenAt: now },
        $inc: { token: 1 },
      },
      { upsert: true, returnDocument: "after" }
    );
    const doc = row?.value ?? row;
    if (!doc) return null;
    return { owner, token: doc.token, expiresAt };
  } catch (err) {
    /* Another process upserted the same _id between our filter and our
       write. That is the race working: they won, we did not. */
    if (err?.code === 11000) return null;
    throw err;
  }
}

/**
 * Still ours? Push the expiry out.
 *
 * Conditional on owner AND token, which is what makes this safe. A
 * process whose lease was taken over has a stale token, matches
 * nothing, and is told it has lost authority — rather than quietly
 * extending a lease somebody else now holds.
 *
 * Returns the same fence on success and null on loss. Null means STOP.
 */
export async function renew(fence, { now = new Date(), ttlMs = LEASE_MS } = {}) {
  if (!fence) return null;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const res = await collections.pollerLease().updateOne(
    { _id: LEASE_ID, owner: fence.owner, token: fence.token },
    { $set: { expiresAt, renewedAt: now } }
  );
  if (!res.matchedCount) {
    log.error("lost the poller lease while working — stopping", {
      owner: fence.owner, token: fence.token,
      note: "another process is authoritative now; this one must not start more fetches",
    });
    return null;
  }
  return { ...fence, expiresAt };
}

/**
 * Read without taking. For the admin page and for diagnosing a quiet
 * poller.
 */
export async function current(now = new Date()) {
  const row = await collections.pollerLease().findOne({ _id: LEASE_ID });
  if (!row?.owner) return null;
  return {
    owner: row.owner,
    token: row.token,
    expiresAt: row.expiresAt,
    takenAt: row.takenAt,
    renewedAt: row.renewedAt ?? null,
    expired: row.expiresAt ? row.expiresAt < now : true,
  };
}

/**
 * Give it up, so the next process does not wait out the TTL.
 *
 * Conditional on the fence for the same reason renewal is: a process
 * that has already lost the lease must not be able to hand the crawl
 * away from whoever legitimately took it over.
 */
export async function release(fence) {
  if (!fence) return false;
  const res = await collections.pollerLease().updateOne(
    { _id: LEASE_ID, owner: fence.owner, token: fence.token },
    { $set: { owner: null, expiresAt: null, releasedAt: new Date() } }
  );
  return res.modifiedCount > 0;
}

/** For tests, and for an operator who knows the holder is gone. */
export async function forceRelease() {
  log.warn("poller lease force-released");
  await collections.pollerLease().updateOne(
    { _id: LEASE_ID },
    { $set: { owner: null, expiresAt: null } },
    { upsert: true }
  );
}
