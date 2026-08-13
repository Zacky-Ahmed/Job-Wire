// emailLog.js
//
// Proves delivery and stops a double-send if the process dies between
// sending and recording.

import { collections } from "../config/db.js";

export function record({ userId, queryId, jobIds, status, providerId, error }) {
  return collections.emailLog().insertOne({
    userId, queryId, jobIds, status,
    providerId: providerId || null,
    error: error || null,
    // Must be set explicitly: findRetryable matches { attempts: { $lt: n } },
    // and Mongo does NOT match documents where the field is absent. Without
    // this every failure is invisible to the retry queue.
    attempts: 0,
    sentAt: new Date(),
  });
}

export function recentForUser(userId, limit = 30) {
  return collections.emailLog()
    .find({ userId }).sort({ sentAt: -1 }).limit(limit).toArray();
}

/** Emails sent today — used to stay inside the Gmail 500/day ceiling. */
export function countToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return collections.emailLog().countDocuments({ sentAt: { $gte: start }, status: "sent" });
}

/**
 * Failed sends worth another attempt.
 *
 * A send can fail for reasons that have nothing to do with the job — a
 * dropped SMTP connection, an unreachable route, Gmail rate-limiting.
 * Without this the alert is lost permanently, because the job is already
 * in seenJobs and no future sweep will rediscover it.
 */
export function findRetryable({ maxAttempts = 3, olderThanMs = 60_000, limit = 5 } = {}) {
  return collections.emailLog()
    .find({
      status: "failed",
      attempts: { $lt: maxAttempts },
      sentAt: { $lte: new Date(Date.now() - olderThanMs) },
    })
    .sort({ sentAt: 1 })
    .limit(limit)
    .toArray();
}

export function markRetried(id, { ok, providerId, error }) {
  return collections.emailLog().updateOne(
    { _id: id },
    {
      $set: {
        status: ok ? "sent" : "failed",
        providerId: providerId || null,
        error: error || null,
        lastTriedAt: new Date(),
      },
      $inc: { attempts: 1 },
    }
  );
}
