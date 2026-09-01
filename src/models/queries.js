// queries.js
//
// Canonical LinkedIn searches. The unique index on (keywordsKey, geoId)
// is what makes 100 users watching "intern / Sri Lanka" cost ONE fetch.

import { collections } from "../config/db.js";

/** Find the shared query row or create it. Never creates a duplicate. */
export async function upsert({ keywordsKey, keywords, geoId, location, everyMinutes, sources, matchAll }) {
  const now = new Date();
  const res = await collections.queries().findOneAndUpdate(
    { keywordsKey, geoId },
    {
      $setOnInsert: {
        keywordsKey, keywords, geoId, location,
        sources: sources?.length ? sources : ["linkedin"],
        matchAll: !!matchAll,
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
  const query = res.value ?? res;

  // Revive a retired row. Everything above that could wake it lives in
  // $setOnInsert, which does not fire for a row that already exists — so
  // re-creating a search someone had deleted would hand back a query with
  // a null nextFetchAt that never swept again. It stays primed, so the
  // user is not re-alerted about the backlog it already remembers.
  if (query && !query.nextFetchAt) {
    await collections.queries().updateOne(
      { _id: query._id },
      { $set: { nextFetchAt: now }, $unset: { retiredAt: "" } }
    );
    query.nextFetchAt = now;
  }
  return query;
}

export function findById(id) {
  return collections.queries().findOne({ _id: id });
}

export function findDue(limit = 20) {
  return collections.queries()
    // $type:"date" is load-bearing. Mongo orders null BEFORE dates, so a
    // bare $lte:<now> matches a null nextFetchAt — meaning a query parked
    // by setting that field to null would have looked permanently due and
    // swept on every single tick, the exact opposite of retiring it.
    .find({ nextFetchAt: { $lte: new Date(), $type: "date" } })
    .sort({ nextFetchAt: 1 })
    .limit(limit)
    .toArray();
}

export async function reschedule(id, { everyMinutes, primed, tracked }) {
  const set = { lastFetchedAt: new Date(), failCount: 0 };
  if (primed !== undefined) set.primed = primed;
  // How many the LAST sweep saw, not a running total. $inc made this
  // climb forever — 574 for a search that returns about 25 — which made
  // it useless for spotting a source that suddenly returns nothing.
  if (tracked !== undefined) set.trackedCount = tracked;
  const update = { $set: set };
  // High-water mark, so a sweep can tell "quiet morning" from "we went
  // blind". $max both compares and initialises on first write.
  if (tracked !== undefined) update.$max = { trackedPeak: tracked };

  // What the sweep saw is recorded either way — a row on its way out still
  // reports its last result to the health page.
  await collections.queries().updateOne({ _id: id }, update);

  // Re-arming, though, is conditional on the row still being scheduled.
  //
  // nextFetchAt:null is how syncSchedule parks a search nobody watches. A
  // sweep already in flight at that moment used to land here afterwards and
  // set nextFetchAt again, reviving a search with zero subscribers — which
  // then swept for ever, taking a slot in the cycle from watches that had
  // somebody behind them. It happened for real on 2026-09-01: the duplicate
  // merge retired "intern@@linkedin" at 14:26:59 and an in-flight sweep
  // rescheduled it at 14:37:15, so a third of the cycle was being spent on
  // a search no account was subscribed to.
  //
  // The same race fires whenever anyone deletes or pauses their last watch
  // mid-sweep, so this is not merely a migration artefact.
  const next = new Date(Date.now() + everyMinutes * 60000);
  return collections.queries().updateOne(
    { _id: id, nextFetchAt: { $ne: null } },
    { $set: { nextFetchAt: next } },
  );
}

/**
 * Stop or resume sweeping, based on whether anyone is actually listening.
 *
 * A query is worth fetching only while at least one ACTIVE subscription
 * points at it. Deleting the last watch was already handled; pausing the
 * last one was not, so a held watch went on spending a full sweep — every
 * page of every source, plus a detail request per new job — to fan out to
 * nobody.
 */
export async function setSweeping(id, shouldSweep) {
  const q = await collections.queries().findOne({ _id: id }, { projection: { nextFetchAt: 1 } });
  if (!q) return;
  const sweeping = q.nextFetchAt != null;
  if (sweeping === shouldSweep) return;          // already in the right state

  await collections.queries().updateOne(
    { _id: id },
    shouldSweep
      // failCount MUST be cleared here. The loop parks a query once it
      // reaches maxFailCount, and the only place failCount resets is
      // reschedule(), which runs after a SUCCESSFUL sweep. Resuming
      // without clearing it handed back a query the loop would park
      // again on sight — for ever, since it never got to attempt a
      // fetch. Resume looked like it worked and silently did nothing.
      ? { $set: { nextFetchAt: new Date(), failCount: 0 }, $unset: { retiredAt: "" } }
      : { $set: { nextFetchAt: null, retiredAt: new Date() } }
  );
}

export function recordFailure(id, backoffMinutes) {
  return collections.queries().updateOne(
    { _id: id },
    { $inc: { failCount: 1 }, $set: { nextFetchAt: new Date(Date.now() + backoffMinutes * 60000) } }
  );
}

/**
 * Park a repeatedly-failing query without touching failCount.
 *
 * recordFailure() was being used for this, and it $incs — so every tick
 * that skipped a parked query pushed its failCount higher, climbing
 * without limit for a query nobody was even attempting to fetch.
 */
export function park(id, minutes) {
  return collections.queries().updateOne(
    { _id: id },
    { $set: { nextFetchAt: new Date(Date.now() + minutes * 60000) } }
  );
}
