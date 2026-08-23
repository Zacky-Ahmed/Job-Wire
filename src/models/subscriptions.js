// subscriptions.js
//
// { userId, queryId, label, active }. Many users -> one query row.

import { collections } from "../config/db.js";
import * as Queries from "./queries.js";

export function listForUser(userId) {
  return collections.subscriptions()
    .aggregate([
      { $match: { userId } },
      { $lookup: { from: "queries", localField: "queryId", foreignField: "_id", as: "q" } },
      { $unwind: "$q" },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();
}

export function countForUser(userId) {
  return collections.subscriptions().countDocuments({ userId });
}

export async function create({ userId, queryId, label }) {
  const doc = { userId, queryId, label, active: true, createdAt: new Date() };
  try {
    const { insertedId } = await collections.subscriptions().insertOne(doc);
    await syncSchedule(queryId);
    return { ...doc, _id: insertedId };
  } catch (err) {
    if (err.code === 11000) return null; // duplicate — the index caught it
    throw err;
  }
}

export async function setActive(userId, id, active) {
  const sub = await collections.subscriptions().findOne({ _id: id, userId });
  if (!sub) return;
  await collections.subscriptions().updateOne({ _id: id, userId }, { $set: { active } });
  await syncSchedule(sub.queryId);
}

/**
 * A shared query should sweep exactly while somebody is listening to it.
 * Called after anything that changes who is: create, pause, resume,
 * delete.
 */
export async function syncSchedule(queryId) {
  const live = await collections.subscriptions().countDocuments({ queryId, active: true });
  await Queries.setSweeping(queryId, live > 0);
}

/**
 * Delete a watch, and retire the shared query if it was the last one
 * pointing at it.
 *
 * Query rows are shared, so deleting a subscription cannot delete the
 * query — someone else may be watching the same search. But nothing was
 * checking the other direction either, so an abandoned query stayed in
 * the due-scan and kept sweeping forever for nobody. A real one was found
 * doing this: a Saudi Arabia search with zero subscribers, swept up to
 * 110 tracked jobs, spending LinkedIn requests on an audience of none.
 *
 * The query is kept, not dropped — its seenJobs rows expire on their own
 * TTL, and if someone re-creates the same search later it comes back
 * already primed instead of swallowing a day of postings in silence.
 * Clearing nextFetchAt is what takes it out of findDue.
 */
export async function remove(userId, id) {
  const sub = await collections.subscriptions().findOne({ _id: id, userId });
  if (!sub) return;
  await collections.subscriptions().deleteOne({ _id: id, userId });

  await syncSchedule(sub.queryId);
}

/** Everyone who should receive an alert for this query. */
export function activeSubscribers(queryId) {
  return collections.subscriptions().find({ queryId, active: true }).toArray();
}
