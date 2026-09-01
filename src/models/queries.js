// queries.js
//
// Canonical LinkedIn searches. The unique index on (keywordsKey, geoId)
// is what makes 100 users watching "intern / Sri Lanka" cost ONE fetch.

import { collections } from "../config/db.js";

/** Find the shared query row or create it. Never creates a duplicate. */
/**
 * What makes two rows THE SAME SEARCH, regardless of how they were spelled.
 *
 * keywordsKey cannot answer this on its own. It used to encode the source
 * picker, so "intern", "intern@@linkedin" and "intern@@keells+linkedin"
 * were three rows issuing byte-identical fetches — the shared-query
 * design, whose whole point is that a hundred people watching one search
 * cost one fetch, was quietly not working, and the three copies stretched
 * a five minute cycle to nine.
 *
 * matchAll deliberately discards the keywords. sweep.js passes
 * `query.matchAll ? [] : query.keywords` to every source, so two
 * "everything in Sri Lanka" watches fetch exactly the same pages no matter
 * what words their owners happened to type into the box.
 */
export function identityOf({ keywords, geoId, matchAll }) {
  if (matchAll) return `${geoId}::*`;
  const kw = [...new Set(
    (keywords || [])
      .map((k) => String(k).trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean)
  )].sort().join("|");
  return `${geoId}::${kw}`;
}

export async function upsert({ keywordsKey, keywords, geoId, location, everyMinutes, sources, matchAll }) {
  const now = new Date();
  const identityKey = identityOf({ keywords, geoId, matchAll });

  /* Rows created before identityKey existed carry no such field, so the
     upsert below would insert a second copy beside them. Stamp them on
     the way past.

     Deliberately NOT matched on keywordsKey: the key is the one thing
     that cannot be trusted here. "intern" and "intern@@linkedin" are the
     same search under two spellings, and a key match would miss exactly
     the rows this exists for — which is how three copies of "intern"
     came to be swept in one cycle.

     The scan is bounded to one country and to rows that have never been
     stamped, so it empties after the first watch created in that country
     and costs a single empty query thereafter. Rows that lack the field
     are the only ones touched, so a live identity is never overwritten. */
  const unstamped = await collections.queries()
    .find({ geoId, identityKey: { $exists: false } }).toArray();
  for (const row of unstamped) {
    await collections.queries().updateOne(
      { _id: row._id }, { $set: { identityKey: identityOf(row) } });
  }

  // Matched on what the row MEANS, not on how its key was spelled, so a
  // new watch joins the existing search and no legacy key can re-split
  // it. Mongo copies the filter's equality field onto an insert, which is
  // why identityKey is not repeated in $setOnInsert.
  const res = await collections.queries().findOneAndUpdate(
    { identityKey },
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
