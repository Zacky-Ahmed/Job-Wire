// queries.js
//
// Canonical LinkedIn searches. The unique index on (keywordsKey, geoId)
// is what makes 100 users watching "intern / Sri Lanka" cost ONE fetch.

import { collections } from "../config/db.js";

/** Find the shared query row or create it. Never creates a duplicate. */
export async function upsert({ keywordsKey, keywords, geoId, location, everyMinutes }) {
  const now = new Date();
  const res = await collections.queries().findOneAndUpdate(
    { keywordsKey, geoId },
    {
      $setOnInsert: {
        keywordsKey, keywords, geoId, location,
        primed: false,          // first sweep memorises, does not alert
        lastFetchedAt: null,
        nextFetchAt: now,       // sweep it immediately to prime
        failCount: 0,
        createdAt: now,
      },
      // If someone wants it faster than the existing row, honour the shorter
      // gap. $min also SETS the field when the document is being inserted,
      // which is why everyMinutes must not also appear in $setOnInsert —
      // Mongo rejects two operators writing the same path in one update.
      $min: { everyMinutes },
    },
    { upsert: true, returnDocument: "after" }
  );
  return res.value ?? res;
}

export function findById(id) {
  return collections.queries().findOne({ _id: id });
}

export function findDue(limit = 20) {
  return collections.queries()
    .find({ nextFetchAt: { $lte: new Date() } })
    .sort({ nextFetchAt: 1 })
    .limit(limit)
    .toArray();
}

export function reschedule(id, { everyMinutes, primed, tracked }) {
  const next = new Date(Date.now() + everyMinutes * 60000);
  const set = { lastFetchedAt: new Date(), nextFetchAt: next, failCount: 0 };
  if (primed !== undefined) set.primed = primed;
  const update = { $set: set };
  if (tracked) update.$inc = { trackedCount: tracked };
  return collections.queries().updateOne({ _id: id }, update);
}

export function recordFailure(id, backoffMinutes) {
  return collections.queries().updateOne(
    { _id: id },
    { $inc: { failCount: 1 }, $set: { nextFetchAt: new Date(Date.now() + backoffMinutes * 60000) } }
  );
}
