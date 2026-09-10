// queries.js
//
// Canonical LinkedIn searches. The unique index on (keywordsKey, geoId)
// is what makes 100 users watching "intern / Sri Lanka" cost ONE fetch.

import { collections } from "../config/db.js";
import { log } from "../utils/logger.js";

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
    { upsert: true, returnDocument: "after",
      /* Deterministic when several rows still share an identity — which
         they can, because identityKey is not unique: rows that predate it
         may already collide and a unique index would fail the signup
         instead of joining it.
         
         Live rows first. Without the sort the pick was arbitrary, so a new
         watch could attach to a RETIRED duplicate rather than the one
         actually sweeping: the watcher would be subscribed to a row with
         no schedule and get nothing. Descending puts real dates ahead of
         the nulls that mark a parked row, and createdAt settles ties. */
      sort: { nextFetchAt: -1, createdAt: 1 } }
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

/**
 * The other live searches in the same country.
 *
 * A sweep fetches a country's jobs and then throws away everything that
 * did not match its own keywords — while another watch, minutes behind on
 * its own schedule, is about to fetch the same board for the same job.
 * Measured over a week: 2,092 LinkedIn jobs were fetched by more than one
 * watch, and 1,975 alerts went out later than the moment we already had
 * the job in memory, a median of 22 minutes later.
 *
 * Same country only. Sources are chosen by country and a search fetches
 * that country's pages, so a Sri Lankan sweep has nothing to say about a
 * German watch. Primed only, so a watch created this minute does not
 * receive a backlog as its first ever email.
 */
export function siblings(geoId, exceptId) {
  return collections.queries()
    .find({
      _id: { $ne: exceptId },
      geoId,
      primed: true,
      nextFetchAt: { $type: "date" },   // parked searches alert nobody
    })
    .toArray();
}

/**
 * @param timing  { scheduledFor, startedAt, finishedAt } — when this
 *   sweep was DUE, when it actually began, and when it ended.
 *
 *   Two numbers fall out of those three and neither was measurable
 *   before. QUEUE DELAY is how long the sweep waited past its due time,
 *   which is the honest answer to "my watch says every five minutes and
 *   I got this twenty minutes late". SERVICE TIME is how long the crawl
 *   itself took, which is what decides whether the requested cadence is
 *   arithmetically possible at all: one serial LinkedIn lane can sustain
 *   Σ(serviceTime / interval) < 1 and no more, and above that the
 *   schedule is a wish rather than a plan.
 *
 *   serviceMsAvg is an exponentially weighted average rather than the
 *   last value, because one slow sweep during a LinkedIn hiccup should
 *   not be read as the new normal, and one fast sweep should not clear
 *   a genuine problem.
 */
export async function reschedule(id, { everyMinutes, primed, tracked, timing }) {
  const set = { lastFetchedAt: new Date(), failCount: 0 };
  if (timing?.startedAt && timing?.finishedAt) {
    const serviceMs = timing.finishedAt - timing.startedAt;
    set.lastServiceMs = serviceMs;
    set.lastStartedAt = new Date(timing.startedAt);
    set.lastFinishedAt = new Date(timing.finishedAt);
    if (timing.scheduledFor) {
      set.lastScheduledFor = new Date(timing.scheduledFor);
      // Never negative: a sweep can run early when the tick catches it,
      // and "minus four minutes late" is not a useful thing to record.
      set.lastQueueDelayMs = Math.max(0, timing.startedAt - new Date(timing.scheduledFor).getTime());
    }
    const prior = await collections.queries().findOne({ _id: id }, { projection: { serviceMsAvg: 1 } });
    set.serviceMsAvg = Number.isFinite(prior?.serviceMsAvg)
      ? Math.round(prior.serviceMsAvg * 0.7 + serviceMs * 0.3)
      : serviceMs;
  }
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
/**
 * Set a shared query's cadence to whatever its live subscribers ask for.
 *
 * Deliberately an assignment, not a $min. $min is how the old ratchet
 * worked: a five-minute watcher could pull a query down to five minutes
 * and nothing could ever pull it back up, so the search kept sweeping
 * twelve times more often than anyone still on it had asked, long after
 * that person had gone. The caller (subscriptions.syncSchedule) computes
 * the minimum across the ACTIVE subscribers, which can go up as well as
 * down because it is recomputed from scratch every time.
 *
 * nextFetchAt is left alone. A query that has just become slower should
 * not have its pending sweep cancelled, and one that has just become
 * faster gets there on its next reschedule — moving it here would let a
 * pause-and-resume loop trigger an immediate fetch on demand.
 */
export async function setInterval(id, everyMinutes) {
  if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return;
  const res = await collections.queries().updateOne(
    { _id: id, everyMinutes: { $ne: everyMinutes } },
    { $set: { everyMinutes } }
  );
  if (res.modifiedCount) {
    log.info("shared query cadence recomputed from its watchers", {
      queryId: String(id), everyMinutes,
    });
  }
  return res.modifiedCount || 0;
}

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
