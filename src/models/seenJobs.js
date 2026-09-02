// seenJobs.js
//
// The set we subtract against. The unique (queryId, jobId) index is what
// makes this safe when two sweeps of one query overlap — the second
// insert loses the race instead of producing a duplicate email.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

/** "14 minutes ago" + when we read it -> an absolute Date. */
function relativeToDate(text, at) {
  const m = /(\d+)\s*(minute|hour|day|week)/i.exec(text || "");
  if (!m) return null;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[m[2].toLowerCase()];
  return new Date(at.getTime() - Number(m[1]) * unit);
}

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

  // Every id must be source-qualified ("linkedin:123"). The unique index
  // is on (queryId, jobId), so "123" and "linkedin:123" look like two
  // different jobs and BOTH get stored — which is exactly what happened
  // when the database was migrated to the prefixed format while the old
  // build was still running and still writing bare ids: 24 duplicates,
  // and a second alert for every one of them.
  //
  // Adapters qualify their ids, so a bare one here is a bug in a new
  // source. Say so loudly rather than quietly duplicating.
  const bare = jobs.filter((j) => !String(j.jobId).includes(":"));
  if (bare.length) {
    log.error("source returned unqualified job ids — they will duplicate", {
      count: bare.length, sample: bare[0].jobId,
    });
  }
  const docs = jobs.map((j) => ({
    queryId,
    jobId: j.jobId,
    title: j.title,
    company: j.company,
    location: j.location,
    url: j.url,
    postedText: j.postedText,
    // Absolute posting time. LinkedIn gives a relative string ("14 minutes
    // ago") which is only meaningful at the moment we read it, so resolve
    // it now — later it silently becomes wrong.
    postedAt: j.postedAt || relativeToDate(j.postedText, now),
    firstSeenAt: now, // the TTL index expires on this field
    // This collection is the dedupe ledger, and it now records the WHOLE
    // country feed — because deciding whether a job matches needs its
    // employment type, which is only readable one job at a time and so
    // has to happen after deduping. Most rows here were merely considered.
    // `matched` is what separates "we looked at this" from "this is the
    // user's job", and it is what the wire renders.
    matched: false,
    matchedBy: null,
    // How many identical requisitions this row stands for. Set only where
    // a source collapsed a group (MAS raises one per plant), so an
    // ordinary job carries no field at all rather than a misleading 1.
    ...(j.openings > 1 ? { openings: j.openings } : {}),
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

/**
 * How many jobs actually matched, across these queries.
 *
 * The wire renders a capped page of rows, and the "Caught" stat used to
 * be that page's length — so it read 50 for a user with 226 matches and
 * would have read 50 for one with exactly 50. A count is a count.
 */
export function countMatched(queryIds) {
  if (!queryIds.length) return Promise.resolve(0);
  return collections.seenJobs()
    .countDocuments({ queryId: { $in: queryIds }, matched: { $ne: false } });
}

/**
 * Scope a query row's history to the person reading it.
 *
 * Query rows are SHARED — that is what makes a hundred people watching
 * "intern / Sri Lanka" cost one fetch. The cost is that subscribing to
 * one inherits everything it ever caught, so a new account opened onto a
 * wire of 232 jobs it had never been told about, thirteen of them from
 * before the account existed. Their own inbox said otherwise.
 *
 * A job belongs to a reader only from the moment they started watching.
 */
function scopedToSubscriptions(pairs) {
  return {
    matched: { $ne: false },
    $or: pairs.map(({ queryId, since }) => ({
      queryId,
      firstSeenAt: since ? { $gte: since } : { $exists: true },
    })),
  };
}

export function recentForSubscriptions(pairs, limit = 50) {
  if (!pairs.length) return Promise.resolve([]);
  return collections.seenJobs()
    .find(scopedToSubscriptions(pairs))
    .sort({ firstSeenAt: -1 })
    .limit(limit)
    .toArray();
}

export function countMatchedForSubscriptions(pairs) {
  if (!pairs.length) return Promise.resolve(0);
  return collections.seenJobs().countDocuments(scopedToSubscriptions(pairs));
}

export function countFor(queryId) {
  return collections.seenJobs().countDocuments({ queryId });
}

/**
 * Park jobs a sweep did not have the request budget to judge.
 *
 * Necessary because insertNew has ALREADY recorded them as seen, so they
 * will never show up as new again — without this flag a deferred job is
 * not deferred at all, it is discarded, which is the precise failure this
 * whole project keeps having to fix.
 */
export async function markPending(queryId, jobs, { failedAttempt = false } = {}) {
  if (!jobs.length) return;
  const update = { $set: { refinePending: true } };
  // Only a FAILED verification counts against the job. Being pushed back
  // because the sweep ran out of request budget is not the job's fault,
  // and counting it would force-accept a perfectly readable job after
  // three busy sweeps.
  if (failedAttempt) update.$inc = { refineAttempts: 1 };
  await collections.seenJobs().updateMany(
    { queryId, jobId: { $in: jobs.map((j) => j.jobId) } },
    update
  );
}

/** Jobs still waiting to be judged, newest first. */
export function pending(queryId, limit = 200) {
  return collections.seenJobs()
    .find({ queryId, refinePending: true })
    .sort({ postedAt: -1 })
    .limit(limit)
    .toArray();
}

/** Judged at last — matched or not, it no longer needs revisiting. */
export async function clearPending(queryId, jobIds) {
  if (!jobIds.length) return;
  await collections.seenJobs().updateMany(
    { queryId, jobId: { $in: jobIds } },
    { $unset: { refinePending: "" } }
  );
}

/** Record which of the jobs we stored the watch actually wanted, and why. */
export async function markMatched(queryId, jobs) {
  if (!jobs.length) return;
  const ops = jobs.map((j) => ({
    updateOne: {
      filter: { queryId, jobId: j.jobId },
      update: { $set: { matched: true, matchedBy: j.matchedBy || "keyword" } },
    },
  }));
  await collections.seenJobs().bulkWrite(ops, { ordered: false });
}

/**
 * The wire shows matched jobs only. Rows left unmatched are the rest of
 * the country's feed — kept so we never reconsider them, never shown,
 * because a list of jobs the user did not ask for is not a wire.
 *
 * Rows written before `matched` existed have no such field; treat those
 * as matched, since under the old code every stored job had already
 * passed a keyword filter.
 */
export function recentForQueries(queryIds, limit = 50) {
  return collections.seenJobs()
    .find({ queryId: { $in: queryIds }, matched: { $ne: false } })
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

/**
 * The public showcase feed for the landing page.
 *
 * Deliberately NOT "the most recent matched jobs". A matchAll watch
 * matches every posting in the country, so an unfiltered feed put a
 * Chief Executive Officer and a Quantity Surveyor at the top of a page
 * arguing about internships. Only keyword watches are drawn from.
 *
 * Deduped by jobId because the same search can exist as several query
 * rows, and the same posting then appears once per row.
 */
export async function recentForShowcase(queryIds, limit = 5) {
  if (!queryIds.length) return [];
  const rows = await collections.seenJobs()
    .find({ queryId: { $in: queryIds }, matched: { $ne: false } })
    .sort({ firstSeenAt: -1 })
    .limit(limit * 6)          // room to dedupe without a second trip
    .toArray();

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.jobId)) continue;
    seen.add(r.jobId);
    out.push(r);
    if (out.length === limit) break;
  }
  return out;
}
