// sweep.js
//
// One query, end to end: build the URL, fetch, parse, diff, fan out to
// every subscriber, reschedule.
//
// One fetch serves every subscriber of the query — that is what keeps
// request volume to LinkedIn flat as users grow.

import { getSource, sourcesForCountry, DEFAULT_SOURCE } from "../sources/index.js";
import { BlockedBySource } from "../http/guardedFetch.js";
import { diff } from "./dedupe.js";
import { sharedFetch, isShared } from "./snapshot.js";
import { normalize } from "../sources/observe.js";
import * as Observations from "../../models/observations.js";
import * as Queries from "../../models/queries.js";
import * as SeenJobs from "../../models/seenJobs.js";
import * as Ledger from "../../models/alertedJobs.js";
import * as Subs from "../../models/subscriptions.js";
import * as Outbox from "../../models/outbox.js";
import { collections } from "../../config/db.js";
import { matchesAny } from "../../utils/match.js";
import { passesPack } from "../packs.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";


// One request per new job, so this bounds how hard a single sweep can
// lean on LinkedIn. Anything over the budget is simply refined next time.
const REFINE_BUDGET = 45;
/* How many "is it actually closed?" checks one sweep may spend. Each is
   one request against the job's own page. Bounded because a catch-up
   sweep could otherwise rediscover hundreds of old postings at once and
   turn a 100 second sweep into a very long one. */
const CLOSURE_CHECK_BUDGET = 12;

// Older than this and a match goes on the wire but not into an email.
// LinkedIn indexes about an hour late, so four hours leaves plenty of
// room while still ruling out yesterday's postings.
const ALERT_MAX_AGE_MIN = 240;

// How many times to re-try reading a job's detail page before giving up
// and taking the job on trust. Bounded so a permanently broken page
// cannot keep a job in limbo for ever.
const MAX_REFINE_ATTEMPTS = 3;


/* Per target watch, per sweep. A ceiling, not a target: the steady state
   is a handful, and the cap exists so that switching this on — or adding a
   watch whose keywords overlap an established one — cannot turn into a
   surprise inbox. Anything above it simply waits for that watch's own
   sweep, which is exactly what happened before this existed. */
const CROSS_MATCH_CAP = 25;

/**
 * Offer what this sweep fetched to every other watch in the same country.
 *
 * Each sweep pulls a country's jobs, keeps what matches its own keywords
 * and discards the rest — while another watch, minutes behind on its own
 * clock, is about to ask the same board for one of the jobs just thrown
 * away. Measured over a week: 2,092 LinkedIn jobs were fetched by more
 * than one watch, and 1,975 alerts went out later than the moment the job
 * was already in memory. Median 22 minutes late; 1,243 of them more than
 * ten minutes late.
 *
 * One of those was the job that prompted this. The same posting was in
 * hand at 03:25:45 for one watch and not delivered to the "intern" watch
 * until 03:39:06 — thirteen minutes during which we already had it.
 *
 * TITLE MATCHES ONLY, and that restriction is the whole safety property.
 * The expensive half of matching asks LinkedIn for a job's employment
 * type, one request each; spending that here would multiply requests by
 * the number of watches and get the scraper blocked, which costs everyone
 * far more than it saves anyone. So this path spends nothing: it either
 * decides from the title it already has, or it leaves the job for the
 * owning watch to refine on its own schedule.
 *
 * It also gets better as the service grows. More watches mean more fetches
 * mean more jobs already in hand, so latency falls as users are added
 * rather than rising — the opposite of how the per-watch sweep scales.
 */
async function shareWithOtherWatches(from, fetched, startedAt) {
  if (!fetched.length) return 0;

  let others;
  try {
    others = await Queries.siblings(from.geoId, from._id);
  } catch (err) {
    log.warn("could not look up sibling watches", { message: err.message });
    return 0;
  }
  if (!others.length) return 0;

  let delivered = 0;
  for (const q of others) {
    const words = q.matchAll ? [] : (q.keywords || []);
    const candidates = fetched.filter((j) => !words.length || matchesAny(j.title, words));
    if (!candidates.length) continue;

    // Same age rule the owning sweep applies, so a job cannot reach an
    // inbox through this door that would have been withheld at that one.
    const worth = candidates.filter(isStillWorthMailing);
    if (!worth.length) continue;

    const known = await Ledger.knownIds(q._id, worth.map((j) => j.jobId));
    const unseen = worth.filter((j) => !known.has(j.jobId)).slice(0, CROSS_MATCH_CAP);
    if (!unseen.length) continue;

    /* Obligations first, ledger second — the same order the main sweep
       uses, and for the same reason.

       This used to claim here and enqueue afterwards, which put the
       whole discovery-to-delivery window back on the sharing path: a
       crash between the two lines meant the target query had these jobs
       marked as met and nobody had been told, and no later sweep would
       offer them again. The enqueue is an upsert, so running this twice
       lands on the same rows rather than mailing twice. */
    await SeenJobs.insertNew(q._id, unseen);
    await SeenJobs.markMatched(q._id, unseen.map((j) => ({ ...j, matchedBy: "title" })));

    const { recipients } = await fanOut(q, unseen, startedAt);
    /* Claimed only now. The unique index still decides a race with the
       target's own sweep — whichever gets here first claims, and the
       loser's enqueue is absorbed by the outbox's own uniqueness rather
       than becoming a second email. */
    await Ledger.remember(q._id, unseen.map((j) => j.jobId));
    const mine = unseen;
    delivered += mine.length;
    log.info("shared a fetch with another watch", {
      from: (from.keywords || []).join("+") || "everything",
      to: (q.keywords || []).join("+") || "everything",
      jobs: mine.length, recipients,
    });
  }
  return delivered;
}

/**
 * Is this job still worth an email, as opposed to merely worth recording?
 */
export function isStillWorthMailing(j) {
    // Only judge age where age is knowable. A board that prints dates and
    // nothing finer resolves every posting to midnight, so a job put up
    // this morning already reads as hours old — this gate silently
    // suppressed EVERY Keells alert, which is why ticking that source
    // produced a wire full of jobs and an inbox with none of them.
    //
    // For those sources the backlog is absorbed by the priming sweep and
    // dedupe: if a job is appearing now and was not there before, it is
    // news, whatever date it prints.
    const src = getSource(j.jobId.split(":")[0]);
    if (src && src.timePrecision === "day") {
      /* Day-precision sources skip the age gate outright.
         
         They used to be refused when the printed date was older than
         SEEN_JOB_TTL_DAYS, because seenJobs forgets a job after that
         window and a still-listed posting would be rediscovered and
         mailed twice. That defence cost more than it saved: Keells
         stamps a listing with the date the vacancy was RAISED and leaves
         it up for months, so "Intern - Supply Chain" reached us printed
         56 days old and "Technical Intern" 672 days old. Both were new
         to us. Both went to the wire. Neither was ever emailed, and
         nothing said so.
         
         Repeat sends are now prevented by remembering what was actually
         mailed (models/alertedJobs.js) rather than by inferring it from
         a date, which lets first sight mean what it says: appearing now
         and absent before is news, whatever the page prints.
         
         It does need ONE bound, though, and not having it was a bug.
         Rooster carries years of listings, and with nothing to stop it
         a first sighting of a posting printed 1,024 days old went out as
         an alert. Age is no longer a proxy for novelty — the ledger does
         that — but a job printed three years ago is not something anyone
         can act on within the hour, which is the only thing an email here
         claims. The wire still keeps it. */
      const printed = j.postedAt ? new Date(j.postedAt) : null;
      if (printed && Date.now() - printed.getTime() > env.staleAlertDays * 86400000) {
        return false;
      }
      return true;
    }

    const at = j.postedAt ? new Date(j.postedAt) : null;
    return !at || Date.now() - at.getTime() <= ALERT_MAX_AGE_MIN * 60000;
}

export async function sweepQuery(query) {
  const started = Date.now();
  /* When this sweep was DUE, captured before anything else touches the
     row. The gap between it and `started` is queue delay — the part of
     "my five-minute watch told me twenty minutes late" that belongs to
     us rather than to the board. */
  const scheduledFor = query.nextFetchAt || null;

  // Every source that covers this country, resolved fresh each sweep
  // rather than read off the row — a watch created before an adapter
  // existed would otherwise never see it, and the reader has no way of
  // knowing they are missing a whole site.
  //
  // Each is fetched independently so one site being down does not cost
  // you the others: a failure is recorded per source, and the sweep still
  // delivers whatever the working ones found.
  const sourceIds = sourcesForCountry(query.geoId);
  if (!sourceIds.length) sourceIds.push(DEFAULT_SOURCE);
  const fetchedMap = new Map();
  const failures = [];

  /* The four boards are fetched CONCURRENTLY, and the reason this is safe
     is worth stating: the serial rule exists so that one HOST never sees a
     burst from us. These are four different hosts. Walking LinkedIn's
     pages one at a time is what matters, and that still happens inside
     each adapter — what changes is that we no longer make topjobs sit and
     wait for LinkedIn to finish.

     It was costing real time. A sweep measured 133 seconds while running
     these end to end, and four searches at that rate drift to a nine
     minute cycle against a five minute schedule. The queue was the
     largest part of the delay this system adds on top of LinkedIn's own. */
  /* This watch's words, resolved once. A match-all watch has none by
     design — sweep.js passes [] everywhere for exactly that reason. */
  const words = query.matchAll ? [] : (query.keywords || []);

  await Promise.all(sourceIds.map(async (sourceId) => {
    const source = getSource(sourceId);
    if (!source) {
      log.warn("watch names a source that no longer exists", { sourceId });
      return;
    }

    /* How deep to page is the ADAPTER's to say, not the sweep's.
       
       This was one guessed number, 4, applied to every source alike. It
       was wrong in both directions: LinkedIn, MAS, topjobs and ITPro page
       internally and return [] after page 0, so three of the four asks
       were wasted; Rooster serves five pages of 100 and its fifth was
       unreachable, hiding roughly a hundred of its ~490 listings.
       
       The loop still stops early when a page adds nothing new, so this is
       a runaway guard rather than a target. */
    const MAX_PAGES = source.maxPages ?? 4;
    const shared = isShared(sourceId);
    /* What the adapter says it did, as opposed to what it returned.

       Merged across pages, because a page that comes back degraded
       degrades the whole walk: a second page whose markup we no longer
       understand is a partial failure even if the first page was
       perfect, and reporting only the last page would hide it. */
    let observed = null;
    const noteObservation = (obs) => {
      if (!observed) { observed = { ...obs, surfaces: { ...obs.surfaces } }; return; }
      observed.requests = (observed.requests ?? 0) + (obs.requests ?? 0);
      observed.pages = (observed.pages ?? 0) + (obs.pages ?? 0);
      observed.rawCount = (observed.rawCount ?? 0) + (obs.rawCount ?? 0);
      observed.warnings = [...observed.warnings, ...obs.warnings];
      observed.surfaces = { ...observed.surfaces, ...obs.surfaces };
      if (obs.status !== "healthy") observed.status = obs.status;
      observed.reported = observed.reported || obs.reported;
    };

    const walkEveryPage = async () => {
      const out = new Map();
      for (let p = 0; p < MAX_PAGES; p++) {
        const raw = await source.fetchJobs({
          // A shared fetch asks for the WHOLE listing. matchAll is how
          // every one of these adapters is told to skip its own keyword
          // filter, and skipping it is the point: the cached result has to
          // belong to the country, not to whichever search asked first.
          keywords: shared ? [] : query.keywords,
          geoId: query.geoId,
          matchAll: shared ? true : !!query.matchAll,
          page: p,
        });
        /* Either shape is accepted. Seven adapters returned a bare array
           yesterday and rewriting all of them in the change whose
           purpose is to make breakage VISIBLE would be seven chances to
           break a working crawl. normalize() infers what it can from an
           array and marks the observation as inferred rather than
           reported, so the difference stays legible. */
        const { jobs, observation } = normalize(raw, { source: sourceId });
        noteObservation(observation);
        if (!jobs.length) break;
        const before = out.size;
        jobs.forEach((j) => out.set(j.jobId, j));
        if (out.size === before) break;
      }
      return [...out.values()];
    };

    try {
      /* One fetch of this board for this country per PASS.

         Per pass, not per four minutes. The old cache was a wall-clock
         TTL and the comment above it claimed "per cycle" — which agree
         only while a pass finishes inside four minutes, and it will not:
         LinkedIn alone is eighty seconds a search, so the pass outgrows
         the window at about three searches and a later query refetches
         a board an earlier one already had. See snapshot.js. */
      const jobs = await sharedFetch(sourceId, query.geoId, walkEveryPage);

      /* THE FILTER THAT WAS MISSING.
         
         A shared listing is the country's, not this watch's, so this
         watch's words are applied here. Leaving it out is what put IT
         Manager, IT Technician and Senior Executive - IT on an "intern"
         wire: the cached result had already been filtered by whichever
         search drove the fetch, and every other search inherited it.
         
         Only for shared sources. A per-query fetch was filtered by its own
         adapter, and LinkedIn's filtering is not a plain title match — it
         keeps jobs the employer tagged Internship whose titles never say
         so, and a title filter here would throw exactly those away. */
      const mine = shared && words.length
        ? jobs.filter((j) => matchesAny(j.title, words))
        : jobs;

      /* Written down whatever happened, including a perfectly healthy
         sweep. A baseline made only of the bad days is not a baseline.

         Skipped when the fetch was served from the shared cache, because
         nothing was observed — recording a cache hit as a fresh
         observation would flood the baseline with duplicates of one real
         measurement and make a genuine collapse look like a rounding
         error. */
      if (observed) {
        await Observations.record({
          source: sourceId, geoId: query.geoId, queryId: query._id,
          observation: observed, ms: Date.now() - started,
        });
        /* AND WHETHER TODAY IS UNUSUAL FOR THIS SURFACE.

           A surface can be perfectly "ok" — 200, right shape, rows
           parsed — and still be returning a fifth of what it normally
           does, which is what a filter change or a silent throttle looks
           like. Nothing in the response says so; only the history does.

           Compared per surface rather than per source on purpose. That
           is the whole point of Phase 5: LinkedIn's country feed can
           hold the total up while the guest keyword surface quietly
           returns nothing, and a source-level comparison would see a
           normal day. */
        for (const [name, surf] of Object.entries(observed.surfaces)) {
          if (!surf.ok || !Number.isFinite(surf.parsedCount)) continue;
          try {
            const base = await Observations.baseline({ source: sourceId, surface: name, geoId: query.geoId });
            if (Observations.isAnomalous(surf.parsedCount, base)) {
              log.error("a source surface returned far less than it normally does", {
                source: sourceId, surface: name,
                sawNow: surf.parsedCount,
                normally: base.median,
                over: `${base.samples} recent sweeps`,
                note: "the response looked fine — suspect a filter change or a silent throttle, not a quiet day",
              });
            }
          } catch (err) {
            log.warn("could not compare a surface against its baseline", {
              source: sourceId, surface: name, message: err.message,
            });
          }
        }

        if (observed.status !== "healthy") {
          log.warn("source answered, but not completely", {
            queryId: String(query._id), source: sourceId,
            warnings: observed.warnings,
            surfaces: Object.entries(observed.surfaces)
              .filter(([, v]) => !v.ok)
              .map(([k, v]) => `${k}: ${v.error || "nothing usable"}`),
          });
        }
      }

      // Map writes are not interleaved: each adapter awaits its own
      // network calls, and JS resumes one continuation at a time, so
      // there is no torn read here even with several running.
      mine.forEach((j) => fetchedMap.set(j.jobId, j));
    } catch (err) {
      failures.push({ sourceId, err });
      log.warn("source failed", {
        queryId: String(query._id), source: sourceId,
        reason: err.name, message: err.message,
      });
    }
  }));

  // Only treat the sweep as failed if EVERY source failed. One site
  // rate-limiting us should not park a watch that has other sources.
  /* Record WHICH sources failed, on the query row. A partial failure
     resets the query as healthy — correctly, since other boards
     answered — but that also meant a source could be dead for weeks with
     nothing anywhere to say so. failCount only counts total wipeouts, so
     a permanently broken LinkedIn behind three working local boards was
     invisible to the admin page and to me. */
  await collections.queries().updateOne(
    { _id: query._id },
    { $set: {
        sourceHealth: sourceIds.map((id) => {
          const bad = failures.find((f) => f.sourceId === id);
          return { source: id, ok: !bad, error: bad ? String(bad.err.message).slice(0, 160) : null,
                   at: new Date() };
        }),
      } }
  );

  if (failures.length === sourceIds.length) {
    const blocked = failures.some((f) => f.err instanceof BlockedBySource);
    const backoff = blocked
      ? Math.min(120, query.everyMinutes * Math.pow(2, (query.failCount || 0) + 1))
      : query.everyMinutes * 2;
    await Queries.recordFailure(query._id, backoff);
    return { ok: false, error: failures.map((f) => f.err.message).join("; ") };
  }

  const fetched = [...fetchedMap.values()];
  const { alertable, primed, storedJobs } = await diff(query, fetched);

  // COVERAGE CHECK.
  //
  // Every failure this project has had with LinkedIn was silent: a narrow
  // f_TPR, an unhonoured sort, a keyword filter that returns 24 results
  // one minute and 3 the next. In each case the sweep "succeeded" and
  // simply saw less, which is indistinguishable from a quiet morning —
  // so the only thing that ever caught it was the user spotting a job on
  // LinkedIn that never reached their inbox. That is the system working
  // backwards.
  //
  // A query that normally yields ~60 jobs and suddenly yields 10 has not
  // gone quiet, it has gone blind. Compare against the best this query
  // has ever done and say so out loud.
  const peak = query.trackedPeak || 0;
  if (peak >= 10 && fetched.length < peak * 0.5) {
    log.error("COVERAGE DROP — this sweep saw far less than this watch normally does", {
      queryId: String(query._id),
      keywords: query.keywords.join("+"),
      sawNow: fetched.length,
      normallySees: peak,
      note: "jobs are probably being missed; suspect a source filter, not a quiet day",
    });
  }

  await Queries.reschedule(query._id, {
    timing: { scheduledFor, startedAt: started, finishedAt: Date.now() },
    everyMinutes: query.everyMinutes,
    primed: true,
    tracked: fetched.length,
  });

  log.info("sweep", {
    queryId: String(query._id),
    keywords: query.keywords.join("+"),
    sources: sourceIds.join(","),
    fetched: fetched.length,
    new: alertable.length,
    priming: primed,
    partial: failures.length ? failures.map((f) => f.sourceId).join(",") : undefined,
    ms: Date.now() - started,
  });

  /* SHARE THE CORPUS HERE, not after this query has finished with it.

     This call used to sit at the very bottom of the sweep, after five
     early returns. Every one of them was a statement about the OWNING
     query — nothing new, nothing fresh enough, nothing matching, nothing
     sendable — and none of them says anything about whether the fetch
     was useful to somebody else. A "supply chain" sweep that turns up
     forty jobs and matches none of them would return at the first of
     those exits, and the "intern" watch two rows down would never be
     offered the intern job that fetch had just paid for.

     The corpus is known by this line and nothing above it can be
     undone, so this is the earliest correct place. It is deliberately
     AFTER the priming return is decided but before it happens — a
     priming sweep has a perfectly good corpus and no reason to keep it
     to itself.

     Matching stays title-only inside shareWithOtherWatches, so this
     costs no extra requests to any board: it is arithmetic over jobs
     already in memory.

     Failure here must not fail a sweep that has already succeeded. */
  if (!primed || (storedJobs || []).length) {
    try {
      await shareWithOtherWatches(query, fetched, new Date(started));
    } catch (err) {
      log.warn("sharing this fetch with other watches failed", { message: err.message });
    }
  }

  if (primed) {
    // The priming sweep alerts on nothing, but it should not leave the
    // wire blank either. Mark what matches on title alone — the cheap
    // half of the test, no request per job. A first sweep is the worst
    // possible moment to fire seventy detail requests at LinkedIn, and
    // these jobs are not being alerted on anyway.
    const words = query.matchAll ? [] : query.keywords;
    const obvious = (storedJobs || []).filter(
      (j) => !words.length || matchesAny(j.title, words)
    );
    await SeenJobs.markMatched(query._id, obvious.map((j) => ({ ...j, matchedBy: "title" })));
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }
  // NOTE: no early return on an empty `alertable`. A sweep that turns up
  // nothing new can still owe verdicts on jobs a previous sweep deferred,
  // and returning here would strand them forever.

  // Freshest first, and only a budget of them per sweep.
  //
  // Refinement costs one request per job. That was fine while the feed
  // was capped at 100 and a sweep turned up a handful of new jobs; with
  // the cap lifted to the feed's real depth, the FIRST sweep after that
  // change meets a hundred-odd jobs it has never seen and would fire a
  // hundred-odd requests in one go — the surest way to get blocked and
  // end up seeing nothing at all.
  //
  // So sort by posting time and spend the budget on the newest, because
  // a job posted eight minutes ago is the entire point and one posted
  // yesterday can wait a sweep. Whatever does not fit is left unmarked
  // and picked up next time.
  // Anything a previous sweep ran out of budget for is still owed a
  // verdict, and it will never arrive as "new" again — insertNew recorded
  // it the first time we saw it. The pending flag is the only thing that
  // brings it back.
  const carried = await SeenJobs.pending(query._id);
  const known = new Set(alertable.map((j) => j.jobId));
  const candidates = [...alertable, ...carried.filter((j) => !known.has(j.jobId))];

  const byNewest = candidates.sort(
    (a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0)
  );
  if (!byNewest.length) return { ok: true, fetched: fetched.length, alerted: 0 };

  // The budget exists because refining costs a request per job. Sources
  // that decide during the fetch — the local boards, which carry the
  // title in the listing and have nothing further to ask — cost nothing
  // extra, so making them queue behind it just delays their alerts by
  // whole sweeps. Measured: a three-board sweep deferred 67 jobs that
  // needed no requests at all.
  const needsRequest = (j) => !!getSource(j.jobId.split(":")[0])?.refine;
  const free = byNewest.filter((j) => !needsRequest(j));
  const costly = byNewest.filter(needsRequest);

  const batch = [...free, ...costly.slice(0, REFINE_BUDGET)];
  const deferred = costly.slice(REFINE_BUDGET);
  await SeenJobs.markPending(query._id, deferred);
  if (deferred.length || carried.length) {
    log.info("refining the newest first; the rest carry to the next sweep", {
      queryId: String(query._id), refining: batch.length,
      carriedIn: carried.length, deferred: deferred.length,
    });
  }

  // Decide what the watch actually wants, now that the list is down to
  // jobs we have never seen. This is where a source may spend a request
  // per job to read details a results page does not carry — affordable
  // here, ruinous if it ran over the whole feed every sweep.
  //
  // Everything fetched is already recorded as seen, so a job rejected
  // here is rejected once and never reconsidered.
  let wanted = batch;
  for (const sourceId of sourceIds) {
    const source = getSource(sourceId);
    if (!source?.refine) continue;
    const mine = wanted.filter((j) => j.jobId.startsWith(sourceId + ":"));
    if (!mine.length) continue;
    try {
      // Keep refine's RETURNED objects, not just their ids. Filtering the
      // originals by id threw away the `matchedBy` verdict, so every job
      // was recorded as a plain keyword hit — and a listing kept only
      // because an employer tagged it "Internship" looked identical to
      // one whose title actually said so. That distinction is the whole
      // point of asking.
      const refined = await source.refine(mine, {
        keywords: query.keywords,
        matchAll: !!query.matchAll,
      });
      wanted = [
        ...wanted.filter((j) => !j.jobId.startsWith(sourceId + ":")),
        ...refined,
      ];
    } catch (err) {
      // Refinement is a narrowing step. If it breaks, send the wider set
      // rather than silently sending nothing.
      log.warn("refine failed — alerting on the unrefined set", {
        source: sourceId, message: err.message,
      });
    }
  }

  // Split off the ones refine could not actually judge. A failed request
  // is not evidence that a job matches: taking "unverified" as a yes put
  // three plainly-wrong jobs into this user's inbox. Retry them on later
  // sweeps instead, and only after several failures fall back to trusting
  // them — because never deciding would lose the job entirely, which is
  // the worse of the two errors.
  const undecided = wanted.filter(
    (j) => j.matchedBy === "unverified" && (j.refineAttempts || 0) < MAX_REFINE_ATTEMPTS
  );
  const undecidedIds = new Set(undecided.map((j) => j.jobId));
  wanted = wanted.filter((j) => !undecidedIds.has(j.jobId));
  if (undecided.length) {
    await SeenJobs.markPending(query._id, undecided, { failedAttempt: true });
    log.info("could not verify some jobs — retrying them next sweep", {
      queryId: String(query._id), undecided: undecided.length,
    });
  }

  await SeenJobs.markMatched(query._id, wanted);
  // Judged either way — matched or rejected — so it stops carrying.
  const settled = batch.filter((j) => !undecidedIds.has(j.jobId)).map((j) => j.jobId);
  await SeenJobs.clearPending(query._id, settled);

  /* Claim what has a verdict, once nothing more is owed on it.

     A job that reached a decision this sweep never needs looking at
     again, whether it matched or not, so it goes on the ledger and stops
     costing a refinement request every five minutes.

     Undecided and deferred jobs are deliberately NOT claimed. They are
     still carrying a refinePending flag and will come back; claiming
     them would mean the next sweep skips them and the verdict never
     arrives. That asymmetry is the reason this is a function called at
     each exit rather than one line at the end — the exits below reach
     the end of the sweep by different routes and every one of them has
     to leave the ledger in the same state. */
  const claimSettled = () => Ledger.remember(query._id, settled);

  if (!wanted.length) {
    log.info("sweep found new jobs but none matched the watch", {
      queryId: String(query._id), considered: batch.length,
    });
    await claimSettled();
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }

  // Store every match so the wire is complete, but only EMAIL the ones
  // that are still worth acting on.
  //
  // Widening the feed makes the system discover jobs that have existed
  // for hours — real matches, but not news. Mailing them is how a catch-
  // up turns into twenty alerts for postings that closed overnight, and
  // an alert that is not actionable trains you to ignore the ones that
  // are. LinkedIn's own indexing runs about an hour behind, so the
  // threshold sits well clear of that.
  const fresh = wanted.filter((j) => isStillWorthMailing(j));

  /* The rule above, as a function, because the cross-match path below has
     to apply exactly the same test. Two copies of "is this too old to be
     worth an email" would drift, and the drift would be silent. */

  /* Second chance for anything the clock rejected.
     
     The age gate above asks "is this old?" when the question that
     matters is "is this still open?". Those came apart badly: LinkedIn's
     index runs a median of 27 minutes late and a 90th percentile of two
     hours, so plenty of live postings reach us past the four hour mark.
     604 of them in one week were saved to the wire and never emailed —
     one missed the cutoff by a single minute.
     
     LinkedIn states the fact outright on the job's own page, so ask it
     rather than guess. Only the jobs the clock already rejected are
     checked, which keeps the cost proportional: the fresh path spends no
     extra requests at all, and a quiet day spends none either. */
  const rejected = wanted.filter((j) => !fresh.includes(j));
  const revived = [];
  let budget = CLOSURE_CHECK_BUDGET;

  for (const j of rejected) {
    if (budget <= 0) break;
    const src = getSource(j.jobId.split(":")[0]);
    if (!src || typeof src.isClosed !== "function") continue;
    budget--;
    const closed = await src.isClosed(j.jobId);
    // null is "we could not tell". A failed request is not evidence that
    // a job is open, so it stays withheld — the same rule that stopped
    // matchedBy:"unverified" being treated as a match.
    if (closed === false) revived.push(j);
  }

  if (revived.length) {
    log.info("older postings confirmed still open — emailing after all", {
      queryId: String(query._id), revived: revived.length,
      checked: Math.min(rejected.length, CLOSURE_CHECK_BUDGET),
    });
    fresh.push(...revived);
  }

  const stale = wanted.length - fresh.length;
  if (stale) {
    log.info("matched older postings — recorded on the wire, not emailed", {
      queryId: String(query._id), stale, olderThanMinutes: ALERT_MAX_AGE_MIN,
    });
  }
  if (!fresh.length) {
    await claimSettled();
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }

  /* No "have we mailed this before?" gate here any more.
     
     There was one, and it was the wrong question asked in the wrong place.
     Novelty is settled in dedupe.js against a ledger that outlives the
     wire's own TTL, so anything reaching this line is a job this search has
     genuinely never met. Asking again after claiming would suppress every
     alert, because claiming is what dedupe now does first. */
  /* LAST LINE OF DEFENCE, and it exists because this has now reached real
     inboxes twice.
     
     Once a shared fetch cached one search's FILTERED result and an intern
     watch was mailed IT Manager and Senior Executive - IT. Once the shared
     listing was not filtered at all and the same watch was mailed Burger
     King Crew Member, Lorry Driver and Chef De Partie. Different bugs, one
     shape: something upstream changed what reached the matcher, and
     nothing between the fetch and the send ever re-asked the question the
     watch actually poses.
     
     So ask it here, where it cannot be skipped. A job kept for a reason
     other than its title is exempt — an employer's "Internship" tag is a
     real match that the title cannot show, and dropping those would undo a
     feature. Everything else must match the words, and one that does not
     is a bug upstream: refuse it, and say so loudly enough to find.
     
     This is deliberately not where matching BELONGS. It is a guard, and a
     guard that fires means something above it is broken. */
  const TITLE_CLAIMS = new Set(["title", "keyword"]);
  const sendable = words.length
    ? fresh.filter((j) => !TITLE_CLAIMS.has(j.matchedBy) || matchesAny(j.title, words))
    : fresh;

  if (sendable.length !== fresh.length) {
    const dropped = fresh.filter((j) => !sendable.includes(j));
    log.error("REFUSED to mail jobs this watch's keywords do not match", {
      queryId: String(query._id),
      keywords: words.join("+"),
      dropped: dropped.length,
      sample: dropped.slice(0, 5).map((j) => `${j.jobId} ${j.title}`),
      note: "the matcher upstream let these through; this guard should never fire",
    });
    /* Unmatched, not forgotten. Deleting the rows would let the next
       sweep rediscover the same jobs and reach the same wrong conclusion
       every five minutes for ever. */
    await SeenJobs.unmatch(query._id, dropped.map((j) => j.jobId), "keyword-guard");
  }
  if (!sendable.length) {
    await claimSettled();
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }

  /* Obligations first, ledger second, and the order is the whole point.

     The claim used to be written by dedupe.diff() the moment a job was
     discovered — before matching, before refinement, before anyone was
     told. Everything that went wrong between there and delivery lost the
     alert permanently, because a claimed job is never offered again.
     Deferring the batch and releasing the claim patched the one case the
     cap caused; it did nothing for a process that simply died.

     Now nothing is claimed until every recipient has a durable row. The
     enqueue is an upsert on (subscription, job, channel), so a sweep
     that dies between these two lines re-runs, re-enqueues onto the same
     rows, and claims on the second pass. The window is gone rather than
     narrowed. */
  const { queued: alerted } = await fanOut(query, sendable, new Date(started));
  await claimSettled();

  return { ok: true, fetched: fetched.length, alerted };
}

/**
 * Write down what this batch owes, to whom, before anything is sent.
 *
 * This used to send. It no longer does — see the note over the bulk
 * write below, and models/outbox.js for why observing a job and
 * notifying a person had to stop being the same fact.
 *
 * `enqueue` is injectable so a test can watch what would be written
 * without a database, and so the failure branches are reachable at all:
 * the all-sends-failed branch shipped with a ReferenceError in it
 * precisely because nothing ever ran it. Production passes neither.
 */
export async function fanOut(
  query, all, startedAt, { enqueue = Outbox.enqueue } = {}
) {
  const subs = await Subs.activeSubscribers(query._id);
  if (!subs.length || !all.length) return { queued: 0, alreadyQueued: 0, recipients: 0 };

  /* PASS ONE: who is owed this batch, and what exactly does each of them
     get? Worked out in full before anything is written, so the write
     itself is one operation that either happens or does not. */
  const owed = [];
  for (const sub of subs) {
    const user = await collections.users().findOne(
      { _id: sub.userId },
      { projection: { email: 1, verified: 1 } }
    );
    // Never mail an address that was not confirmed.
    if (!user?.verified) continue;

    /* A sweep can run for minutes. Someone who subscribed midway through
       would otherwise be emailed everything it found, including jobs
       discovered before their watch existed — while the wire, which
       scopes by subscription createdAt, showed them nothing of the kind.
       The two disagreed about what belonged to the reader.

       The comparison is against the instant the sweep STARTED, not
       against the jobs: `fresh` is built from the source adapters and
       has no firstSeenAt on it, so filtering by that field silently
       matched everything and fixed nothing. */
    if (sub.createdAt && startedAt && sub.createdAt > startedAt) {
      log.info("skipping a watch created mid-sweep", {
        queryId: String(query._id), userId: String(sub.userId),
      });
      continue;
    }

    /* The subscriber's own narrowing. A pack is the AND half of a watch:
       the keyword decides what is a job worth looking at, the pack decides
       whether it is about the right subject. EMAIL ONLY — the wire keeps
       showing everything the watch caught. */
    const jobs = sub.emailPack
      ? all.filter((j) => passesPack(j.title, sub.emailPack))
      : all;
    if (!jobs.length) {
      log.info("nothing in this batch matched the watcher's filter", {
        queryId: String(query._id), pack: sub.emailPack, considered: all.length,
      });
      continue;
    }

    owed.push({ sub, user, jobs });
  }

  if (!owed.length) return { queued: 0, alreadyQueued: 0, recipients: 0 };

  /* ONE WRITE, AND IT IS THE POINT OF THE WHOLE CHANGE.

     What used to be here was a loop that called the mail provider once
     per recipient. Everything about that loop was a way to lose an
     alert: the daily cap returned before the loop and the batch, already
     claimed on the ledger, was never offered again; an exception on
     recipient three meant four through ten never got a row at all; and a
     process killed between the claim and this point lost the lot,
     silently, with the ledger insisting it had been dealt with.

     Now every intended recipient gets a durable row BEFORE any provider
     is called, in a single bulk write. After this line the obligation
     exists and only delivery or the watch disappearing can remove it. A
     crash costs a delay, not an alert.

     The cap is gone from here entirely. It belongs to the worker that
     drains this queue, where it can defer one person's mail without
     touching anybody else's — which is what turns "we hit the ceiling"
     from a batch-level verdict into a per-message one. */
  const items = owed.flatMap(({ sub, user, jobs }) =>
    jobs.map((job) => ({
      subscriptionId: sub._id,
      userId: sub.userId,
      queryId: query._id,
      job,
      label: sub.label,
      email: user.email,
      discoveredAt: startedAt || new Date(),
    }))
  );

  const { queued, alreadyQueued } = await enqueue(items);

  /* alreadyQueued is not an error and is not usually a surprise. The
     enqueue is an upsert on (subscription, job, channel) precisely so a
     sweep that died after writing these rows and before claiming the
     ledger can run again and land on the same rows instead of writing a
     second set. Seeing a number here after a crash is the mechanism
     working. */
  log.info("obligations recorded", {
    queryId: String(query._id),
    recipients: owed.length,
    jobs: all.length,
    queued,
    ...(alreadyQueued ? { alreadyQueued } : {}),
  });

  return { queued, alreadyQueued, recipients: owed.length };
}
