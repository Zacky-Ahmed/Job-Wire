// subscriptions.js
//
// { userId, queryId, label, active }. Many users -> one query row.

import { collections } from "../config/db.js";

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
    return { ...doc, _id: insertedId };
  } catch (err) {
    if (err.code === 11000) return null; // duplicate — the index caught it
    throw err;
  }
}

export function setActive(userId, id, active) {
  return collections.subscriptions().updateOne({ _id: id, userId }, { $set: { active } });
}

export function remove(userId, id) {
  return collections.subscriptions().deleteOne({ _id: id, userId });
}

/** Everyone who should receive an alert for this query. */
export function activeSubscribers(queryId) {
  return collections.subscriptions().find({ queryId, active: true }).toArray();
}
