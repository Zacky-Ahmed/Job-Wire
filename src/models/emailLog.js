// emailLog.js
//
// Proves delivery and stops a double-send if the process dies between
// sending and recording.

import { collections } from "../config/db.js";

/**
 * Open a row BEFORE handing the message to the provider.
 *
 * Recording only after the send meant a crash between "provider accepted
 * it" and "we wrote it down" left the jobs deduped with no log row: no
 * alert, and nothing for the retry queue to find, so it was lost for
 * good. A row opened first turns that same crash into a visible
 * "sending" row that findRetryable picks up.
 */
export async function open({ userId, queryId, jobIds }) {
  const { insertedId } = await collections.emailLog().insertOne({
    userId, queryId, jobIds,
    status: "sending",
    providerId: null,
    error: null,
    attempts: 0,
    sentAt: new Date(),
  });
  return insertedId;
}

/** Close the row the send was opened with. */
export function settle(id, { ok, providerId, error }) {
  return collections.emailLog().updateOne(
    { _id: id },
    { $set: {
        status: ok ? "sent" : "failed",
        providerId: providerId || null,
        error: error || null,
        // sentAt is stamped at COMPLETION so the daily cap counts the day
        // the mail actually went out.
        sentAt: new Date(),
      } }
  );
}

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

/**
 * Emails sent to ONE person today.
 *
 * The dashboard used to show the instance-wide figure to everybody, so a
 * brand-new account with an empty inbox was greeted by "4 emails sent
 * today" — four emails that went to other people. A per-user page must
 * count per user.
 */
/**
 * Every send that mentions one of these jobs, for this user.
 *
 * The wire used to ask for "the newest 30 emails" and hope that covered
 * the 50 rows it was about to draw. That is the wrong question: delivery
 * is a fact about a JOB, so ask about the jobs. Measured on the developer
 * account, 28 of those 30 were already needed — two more single-job sends
 * and delivered jobs would have started rendering as never sent.
 */
export function forJobs(userId, jobIds) {
  if (!jobIds.length) return Promise.resolve([]);
  return collections.emailLog()
    .find({ userId, jobIds: { $in: jobIds } })
    .sort({ sentAt: -1 })
    .toArray();
}

export function countTodayForUser(userId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return collections.emailLog()
    .countDocuments({ userId, sentAt: { $gte: start }, status: "sent" });
}

/**
 * Emails sent today by the whole instance — the figure that matters for
 * the provider's daily ceiling, because that ceiling is shared. Used by
 * the poller and the admin page, never as a personal statistic.
 */
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
export function findRetryable({ maxAttempts = 3, olderThanMs = 60_000,
                               stalledAfterMs = 5 * 60_000, limit = 5 } = {}) {
  const now = Date.now();
  return collections.emailLog()
    .find({
      /* Two different situations, so two different clocks.
         "failed" means the provider said no and a minute is long enough
         to wait. "sending" means a row was opened and never closed —
         which is either a crash, or a send still in flight. Reclaiming
         those on the same one-minute clock would retry a message that is
         still being delivered and send it twice, so they need a grace
         period comfortably past every provider timeout we set (Brevo 20s,
         SMTP socket 30s). Five minutes clears all of them. */
      $and: [{ $or: [
        { status: "failed",  sentAt: { $lte: new Date(now - olderThanMs) } },
        { status: "sending", sentAt: { $lte: new Date(now - stalledAfterMs) } },
      ] }],
      // Rows written before `attempts` existed have no such field, and
      // { $lt: n } does NOT match a missing field — those failures would
      // be permanently invisible to the retry queue. Treat absent as 0.
      $or: [{ attempts: { $lt: maxAttempts } }, { attempts: { $exists: false } }],
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
  /* Move sentAt to now when the retry succeeds. countToday() filters on
     sentAt, so a message that failed yesterday and went out today kept
     yesterday's stamp and never counted against today's cap — the
     provider's quota and our own accounting drifted apart, silently, in
     the direction that overspends. */
  if (ok) update.$set.sentAt = new Date();
  // Only real, transient failures count against the attempt budget.
  if (!ok && !isConfigError(error)) update.$inc = { attempts: 1 };
  return collections.emailLog().updateOne({ _id: id }, update);
}
