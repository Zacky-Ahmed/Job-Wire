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
