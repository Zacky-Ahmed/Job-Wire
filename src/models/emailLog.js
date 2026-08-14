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
      // Rows written before `attempts` existed have no such field, and
      // { $lt: n } does NOT match a missing field — those failures would
      // be permanently invisible to the retry queue. Treat absent as 0.
      $or: [{ attempts: { $lt: maxAttempts } }, { attempts: { $exists: false } }],
      sentAt: { $lte: new Date(Date.now() - olderThanMs) },
    })
    .sort({ sentAt: 1 })
    .limit(limit)
    .toArray();
}

/**
 * A failure that a human must fix — a rejected API key, an unverified
 * sender, a bad password. Retrying these is pointless: the outcome is
 * identical every time.
 *
 * They must NOT consume an attempt, or the queue exhausts itself in the
 * ninety seconds before anyone notices, and the alerts are lost even
 * after the config is corrected. Observed twice: a wrong Brevo key
 * burned all three attempts before the right one could be deployed.
 */
export function isConfigError(error = "") {
  return /401|403|key not found|sender not verified|invalid login|not accepted|unauthor/i
    .test(String(error));
}

export function markRetried(id, { ok, providerId, error }) {
  const update = {
    $set: {
      status: ok ? "sent" : "failed",
      providerId: providerId || null,
      error: error || null,
      lastTriedAt: new Date(),
    },
  };
  // Only real, transient failures count against the attempt budget.
  if (!ok && !isConfigError(error)) update.$inc = { attempts: 1 };
  return collections.emailLog().updateOne({ _id: id }, update);
}
