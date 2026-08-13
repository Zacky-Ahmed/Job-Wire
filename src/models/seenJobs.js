// seenJobs.js
//
// The set we subtract against. The unique (queryId, jobId) index is what
// makes this safe when two sweeps of one query overlap — the second
// insert loses the race instead of producing a duplicate email.

import { collections } from "../config/db.js";

export async function knownIds(queryId, jobIds) {
  const rows = await collections.seenJobs()
    .find({ queryId, jobId: { $in: jobIds } }, { projection: { jobId: 1 } })
    .toArray();
  return new Set(rows.map((r) => r.jobId));
}

/**
 * Insert jobs we have not seen. Returns the ones THIS call actually
 * inserted — if a concurrent sweep inserted the same job first, its
 * duplicate-key error is swallowed and the job is not returned, so only
 * one sweep can ever alert on it.
 */
export async function insertNew(queryId, jobs) {
  if (!jobs.length) return [];
  const now = new Date();
  const docs = jobs.map((j) => ({
    queryId,
    jobId: j.jobId,
    title: j.title,
    company: j.company,
    location: j.location,
    url: j.url,
    postedText: j.postedText,
    postedAt: j.postedAt,
    firstSeenAt: now, // the TTL index expires on this field
  }));

  try {
    await collections.seenJobs().insertMany(docs, { ordered: false });
    return jobs;
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors) throw err;
    const lost = new Set((err.writeErrors || []).map((e) => docs[e.index]?.jobId));
    return jobs.filter((j) => !lost.has(j.jobId));
  }
}

export function countFor(queryId) {
  return collections.seenJobs().countDocuments({ queryId });
}

export function recentForQueries(queryIds, limit = 50) {
  return collections.seenJobs()
    .find({ queryId: { $in: queryIds } })
    .sort({ firstSeenAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Un-remember jobs. Used when every alert for them failed to send: if we
 * kept them, the next sweep would treat them as already seen and the
 * user would never hear about those jobs at all. Forgetting lets the
 * next sweep rediscover and retry them.
 */
export function forget(queryId, jobIds) {
  if (!jobIds.length) return Promise.resolve();
  return collections.seenJobs().deleteMany({ queryId, jobId: { $in: jobIds } });
}
