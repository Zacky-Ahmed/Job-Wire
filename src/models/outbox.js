// outbox.js
//
// A durable promise to tell one person about one job.
//
// THE DISTINCTION THIS FILE EXISTS FOR: observing a job, matching it,
// and notifying somebody are three separate facts, and the code used to
// conflate the first with the third. alertedJobs records that a SEARCH
// has met a job. It was also, in practice, the thing deciding whether a
// PERSON would ever hear about it — because once a job was claimed there
// no later sweep would offer it again, so anything that went wrong
// between the claim and the send lost the alert permanently and
// silently.
//
// Three ways that happened, none of them theoretical:
//
//   · the process died between the claim and the match;
//   · the process died between the match and the emailLog row;
//   · one subscriber's send threw, and the loop never reached the rest.
//
// A fourth — the daily cap returning without sending — was patched by
// deferring the whole batch and releasing the claim, which works only
// because nobody in that batch had been served yet. That patch is what
// this replaces: with an obligation per recipient, the cap can defer one
// person's mail without touching anybody else's, and "we hit the
// ceiling" stops being a batch-level decision.
//
// So: before any provider is called, every intended recipient gets a row
// here. A row is only ever removed by being delivered or by the watch
// behind it disappearing. Nothing else may delete one.
//
// UNIQUENESS is per SUBSCRIPTION, not per user:
//
//   UNIQUE(subscriptionId, jobId, channel)
//
// which preserves exactly today's behaviour — if one person's three
// watches all match a job, they get three emails, as they do now. The
// alternative, UNIQUE(userId, jobId, channel), would collapse those into
// one email listing three watches; that is probably better, but it
// changes what people receive, and bundling a visible change into the
// commit that rewrites delivery would make it impossible to tell which
// half was responsible when something looked wrong. matchedSubscriptionIds
// is written from the first day so that switching later is an index
// change rather than a redesign.

import { randomUUID } from "node:crypto";
import { collections } from "../config/db.js";

/** Not yet delivered, and still owed. */
export const PENDING = "pending";
/** A worker has taken it and is calling the provider. */
export const SENDING = "sending";
/** Delivered. Kept for a while so the wire can say so. */
export const SENT = "sent";
/** Tried enough times, or refused for a reason retrying will not fix. */
export const DEAD = "dead";
/**
 * Undeliverable until a PERSON changes something — a rejected
 * credential, an unverified sender.
 *
 * Deliberately not DEAD. The first version settled these dead on the
 * very first failure, which contradicted the comment right beside it
 * saying obligations stay pending, and meant the first batch to discover
 * a wrong API key was destroyed while every batch after it was correctly
 * held. DEAD should mean "we have decided never to deliver this"; a
 * typo in an environment variable is not that decision.
 *
 * Nothing retries a blocked row on a timer, because no amount of waiting
 * fixes a wrong password. They are released in a batch once the provider
 * answers again — see unblockAll().
 */
export const BLOCKED = "blocked";

/**
 * Record what we owe, before anything is sent.
 *
 * Every write is an upsert on the unique key, so this is safe to call
 * again with the same jobs: a sweep that crashed after enqueueing and
 * before claiming will re-enqueue on the next pass, and the duplicates
 * land on the rows that already exist rather than becoming second
 * emails. That idempotence is what lets the ledger claim move AFTER the
 * enqueue, which is what closes the discovery-to-delivery gap.
 *
 * The job itself is copied in, not referenced. seenJobs expires after
 * fourteen days and a retry three weeks later must not fail because the
 * only copy of the title has gone; an outbox row has to carry enough to
 * write the email on its own.
 */
export async function enqueue(items) {
  if (!items.length) return { queued: 0, alreadyQueued: 0 };
  const now = new Date();

  const ops = items.map((it) => ({
    updateOne: {
      filter: { subscriptionId: it.subscriptionId, jobId: it.job.jobId, channel: it.channel || "email" },
      update: {
        $setOnInsert: {
          subscriptionId: it.subscriptionId,
          userId: it.userId,
          queryId: it.queryId,
          jobId: it.job.jobId,
          channel: it.channel || "email",
          /* Immutable copy. See above: a retry cannot depend on a
             fourteen-day cache still holding the job. */
          job: {
            jobId: it.job.jobId,
            title: it.job.title,
            company: it.job.company,
            location: it.job.location,
            url: it.job.url,
            postedAt: it.job.postedAt ?? null,
            postedText: it.job.postedText ?? "",
            source: String(it.job.jobId).split(":")[0],
          },
          label: it.label,
          email: it.email,
          matchedSubscriptionIds: it.matchedSubscriptionIds || [it.subscriptionId],
          /* Generated once, here, and never again.

             A provider that supports idempotency keys refuses to deliver
             the same message twice when it sees the same key. That only
             works if a RETRY carries the key the first attempt used — a
             fresh key per attempt is a fresh message, and the mechanism
             does nothing at all. So it belongs to the obligation, and
             $setOnInsert is what guarantees a re-enqueue cannot replace
             it. It is what makes a timeout safe to retry: we cannot tell
             an accepted-then-lost response from a refusal, and without
             this the safe reading of a timeout would be "give up". */
          idempotencyKey: randomUUID(),
          status: PENDING,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          discoveredAt: it.discoveredAt || now,
          lastError: null,
        },
      },
      upsert: true,
    },
  }));

  const res = await collections.outbox().bulkWrite(ops, { ordered: false });
  const queued = res.upsertedCount || 0;
  return { queued, alreadyQueued: items.length - queued };
}

/**
 * SEAL a batch: fix exactly which obligations one provider message
 * carries, and give that message its own identity.
 *
 * THE BUG THIS EXISTS FOR. Every obligation was born with its own
 * idempotency key, and the worker then grouped several obligations into
 * one email and sent it under the FIRST row's key. Those two
 * abstractions do not line up, and the gap is dangerous:
 *
 *   attempt 1   rows A+B, key = A's        provider ACCEPTS
 *               the response is lost; A+B go back to pending
 *   meanwhile   row C is queued for the same person
 *   attempt 2   rows A+B+C, key = A's      provider says "seen A's key"
 *
 * We would read that as success and mark A, B and C delivered — but the
 * message the provider actually accepted contained only A and B. C is
 * marked sent and was never in any email.
 *
 * So the batch is sealed BEFORE the provider is called: the rows get a
 * shared batchId and one batchKey, written durably. A retry regroups by
 * batchId, so the message is byte-for-byte the one the key describes.
 * C cannot join it; C forms the next batch with its own key.
 *
 *   one provider request  =  one immutable set of obligations  =  one key
 */
export async function sealBatch(rows, { now = new Date() } = {}) {
  const existing = rows.find((r) => r.batchId);
  /* An already-sealed batch keeps its identity. This is the whole point:
     a retry must reuse the key the first attempt used, or the provider
     sees a new message and delivers the same jobs twice. */
  const batchId = existing?.batchId || randomUUID();
  const batchKey = existing?.batchKey || randomUUID();

  const ids = rows.map((r) => r._id);
  await collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { batchId, batchKey, sealedAt: existing?.sealedAt || now } }
  );
  return { batchId, batchKey, ids };
}

/**
 * Take the next batch of work, marking it SENDING so a second worker
 * cannot take the same rows.
 *
 * Claimed one findOneAndUpdate at a time rather than with an updateMany
 * plus a read: updateMany followed by a query is two operations with a
 * gap between them, and two workers can both see the same rows in that
 * gap. This is slower and correct.
 *
 * `limit` is the caller's remaining budget for the day. The cap is
 * enforced by not claiming, so a capped row stays PENDING and is offered
 * again tomorrow — the ceiling now means "later", with no batch-level
 * decision and nothing released.
 */
export async function claimBatch({ limit = 25, now = new Date(), owner = "worker" } = {}) {
  const taken = [];
  for (let i = 0; i < limit; i++) {
    const row = await collections.outbox().findOneAndUpdate(
      { status: PENDING, nextAttemptAt: { $lte: now } },
      { $set: { status: SENDING, claimedAt: now, claimedBy: owner }, $inc: { attempts: 1 } },
      { sort: { discoveredAt: 1, _id: 1 }, returnDocument: "after" }
    );
    if (!row) break;
    taken.push(row);
  }
  return taken;
}

/**
 * A row whose worker died mid-send goes back to PENDING.
 *
 * SENDING is not a resting state. Without this, a process killed between
 * the claim and the settle leaves the row claimed for ever — which is
 * the same permanent loss this whole file exists to prevent, just moved
 * one step later.
 *
 * The window has to be longer than a provider call can reasonably take,
 * because reclaiming a row whose send is still in flight sends it twice.
 */
export async function reclaimStale({ olderThanMs = 5 * 60_000, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const res = await collections.outbox().updateMany(
    { status: SENDING, claimedAt: { $lt: cutoff } },
    { $set: { status: PENDING, nextAttemptAt: now, lastError: "reclaimed after a worker went away" } }
  );
  return res.modifiedCount || 0;
}

/** Delivered. */
export function settleSent(ids, { providerMessageId = null, now = new Date() } = {}) {
  if (!ids.length) return Promise.resolve();
  return collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { status: SENT, sentAt: now, providerMessageId, lastError: null } }
  );
}

/**
 * Not delivered, and worth another go later.
 *
 * nextAttemptAt is what schedules the retry, not the original send time.
 * The old retry queue re-read rows by `sentAt` and re-attempted every
 * poller tick regardless of why the last one failed, which is how a
 * broken credential produced 43 attempts in an evening.
 */
export function settleRetry(ids, { error, nextAttemptAt, now = new Date() }) {
  if (!ids.length) return Promise.resolve();
  return collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { status: PENDING, nextAttemptAt, lastTriedAt: now, lastError: String(error || "").slice(0, 300) } }
  );
}

/**
 * Held until somebody fixes the configuration.
 *
 * Not a retry — there is nothing to wait for — and not death. The rows
 * keep their sealed batch, so when the credentials are corrected the
 * same message goes out under the same key.
 */
export function settleBlocked(ids, { error, now = new Date() }) {
  if (!ids.length) return Promise.resolve();
  return collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { status: BLOCKED, blockedAt: now, lastError: String(error || "").slice(0, 300) } }
  );
}

/**
 * The configuration was fixed. Offer everything again.
 *
 * Called when the provider accepts a message after having refused one,
 * so a corrected key drains the whole backlog rather than only the rows
 * that happened to be claimed next.
 */
export async function unblockAll({ now = new Date() } = {}) {
  const res = await collections.outbox().updateMany(
    { status: BLOCKED },
    { $set: { status: PENDING, nextAttemptAt: now, unblockedAt: now } }
  );
  return res.modifiedCount || 0;
}

/**
 * No longer owed — the watch was paused or deleted, or the account went
 * away between queueing and sending.
 *
 * Distinct from DEAD, which means we tried and failed. Nothing was
 * wrong here; the obligation simply stopped existing, and saying so is
 * worth more than deleting the row silently.
 */
export function cancel(ids, { reason, now = new Date() }) {
  if (!ids.length) return Promise.resolve();
  return collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { status: "cancelled", cancelledAt: now, cancelledReason: reason } }
  );
}

/** Out of attempts, or refused for a reason retrying cannot fix. */
export function settleDead(ids, { error, now = new Date() }) {
  if (!ids.length) return Promise.resolve();
  return collections.outbox().updateMany(
    { _id: { $in: ids } },
    { $set: { status: DEAD, diedAt: now, lastError: String(error || "").slice(0, 300) } }
  );
}

/** How much is owed right now, for the admin page and the tests. */
export async function counts() {
  const rows = await collections.outbox().aggregate([
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]).toArray();
  const out = { pending: 0, sending: 0, sent: 0, dead: 0 };
  for (const r of rows) if (r._id in out) out[r._id] = r.n;
  return out;
}

/** Everything owed to one person, newest first — used by the wire. */
export function pendingForUser(userId, limit = 200) {
  return collections.outbox()
    .find({ userId, status: { $in: [PENDING, SENDING] } })
    .sort({ discoveredAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * A watch is gone, so what it promised is no longer owed.
 *
 * The one legitimate reason to delete a pending obligation. Rows already
 * SENT are left alone: they are history, and the wire still reports on
 * them.
 */
export function forgetSubscription(subscriptionId) {
  return collections.outbox().deleteMany({
    subscriptionId,
    status: { $in: [PENDING, SENDING] },
  });
}

/** Same, for a whole query being deleted. */
export function forgetQuery(queryId) {
  return collections.outbox().deleteMany({
    queryId,
    status: { $in: [PENDING, SENDING] },
  });
}
