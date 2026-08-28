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
import * as Queries from "../../models/queries.js";
import * as SeenJobs from "../../models/seenJobs.js";
import * as Subs from "../../models/subscriptions.js";
import * as EmailLog from "../../models/emailLog.js";
import { collections } from "../../config/db.js";
import { matchesAny } from "../../utils/match.js";
import { sendAlert } from "../mail/send.js";
import { dailyCap } from "../mail/transport.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";


// One request per new job, so this bounds how hard a single sweep can
// lean on LinkedIn. Anything over the budget is simply refined next time.
const REFINE_BUDGET = 45;

// Older than this and a match goes on the wire but not into an email.
// LinkedIn indexes about an hour late, so four hours leaves plenty of
// room while still ruling out yesterday's postings.
const ALERT_MAX_AGE_MIN = 240;

// How many times to re-try reading a job's detail page before giving up
// and taking the job on trust. Bounded so a permanently broken page
// cannot keep a job in limbo for ever.
const MAX_REFINE_ATTEMPTS = 3;

export async function sweepQuery(query) {
  const started = Date.now();

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

  for (const sourceId of sourceIds) {
    const source = getSource(sourceId);
    if (!source) {
      log.warn("watch names a source that no longer exists", { sourceId });
      continue;
    }

    // Sources page 10-ish at a time, so keep asking until a page adds
    // nothing new. Capped, because a broken "next page" that repeats
    // itself would otherwise loop until the request budget is gone.
    const MAX_PAGES = 4;
    try {
      for (let p = 0; p < MAX_PAGES; p++) {
        const jobs = await source.fetchJobs({
          keywords: query.keywords,
          geoId: query.geoId,
          matchAll: !!query.matchAll,
          page: p,
        });
        if (!jobs.length) break;

        const before = fetchedMap.size;
        jobs.forEach((j) => fetchedMap.set(j.jobId, j));
        if (fetchedMap.size === before) break;
      }
    } catch (err) {
      failures.push({ sourceId, err });
      log.warn("source failed", {
        queryId: String(query._id), source: sourceId,
        reason: err.name, message: err.message,
      });
    }
  }

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

  if (!wanted.length) {
    log.info("sweep found new jobs but none matched the watch", {
      queryId: String(query._id), considered: batch.length,
    });
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
  const fresh = wanted.filter((j) => {
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
      /* Day-precision sources skip the age gate, and that exemption is
         what makes the dedupe TTL load-bearing. seenJobs expires after
         SEEN_JOB_TTL_DAYS; a local-board posting still listed after that
         window is forgotten, rediscovered, and — with no age gate to
         stop it — emailed a second time as though it were new.
         postedAt is the only defence left, so use it where the board
         gave us one: a posting older than the TTL cannot be news. */
      const posted = j.postedAt ? new Date(j.postedAt) : null;
      if (posted && Date.now() - posted.getTime() >
          env.seenJobTtlDays * 24 * 60 * 60000) {
        return false;
      }
      return true;
    }

    const at = j.postedAt ? new Date(j.postedAt) : null;
    return !at || Date.now() - at.getTime() <= ALERT_MAX_AGE_MIN * 60000;
  });
  const stale = wanted.length - fresh.length;
  if (stale) {
    log.info("matched older postings — recorded on the wire, not emailed", {
      queryId: String(query._id), stale, olderThanMinutes: ALERT_MAX_AGE_MIN,
    });
  }
  if (!fresh.length) return { ok: true, fetched: fetched.length, alerted: 0 };

  const alerted = await fanOut(query, fresh, new Date(started));
  return { ok: true, fetched: fetched.length, alerted };
}

/** One email per subscriber per sweep, carrying every new job at once. */
async function fanOut(query, jobs, startedAt) {
  const subs = await Subs.activeSubscribers(query._id);
  if (!subs.length) return 0;

  /* Counted ONCE before the loop, this was a ceiling in name only: with
     279 of 280 used and a hundred watchers on a shared query, the check
     passed once and then sent a hundred. The running total is tracked
     locally and re-checked before every individual send, so the cap
     bounds the fan-out rather than merely gating its start. */
  const cap = dailyCap();
  let sentToday = await EmailLog.countToday();
  if (sentToday >= cap) {
    log.warn("daily mail ceiling reached — alerts suppressed", { sentToday, cap });
    return 0;
  }

  let sent = 0;
  let eligible = 0;
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
    eligible++;

    if (sentToday >= cap) {
      log.warn("daily mail ceiling reached mid fan-out — remaining watchers skipped", {
        queryId: String(query._id), cap, delivered: sent,
      });
      break;
    }

    /* Open the row BEFORE the provider is called. Sending first and
       recording after meant a crash in between left the jobs deduped
       with no log row at all: no alert, and nothing for the retry queue
       to find, so it was gone for good. Opening first turns that into a
       "sending" row the queue reclaims once it goes stale. */
    const logId = await EmailLog.open({
      userId: sub.userId,
      queryId: query._id,
      jobIds: jobs.map((j) => j.jobId),
    });
    sentToday++;

    const res = await sendAlert({ to: user.email, label: sub.label, jobs });
    await EmailLog.settle(logId, { ok: res.ok, providerId: res.id, error: res.error });
    if (res.ok) sent++;
  }

  // NOTE: we deliberately do NOT un-remember the jobs when a send fails.
  //
  // An earlier version did, so the next sweep would rediscover them. With
  // a persistent fault — an IPv6 route that does not exist, say — that
  // became an infinite loop: forget, re-catch, fail, forget, every five
  // minutes, writing a fresh emailLog row each time. 43 of them in one
  // evening for the same handful of jobs.
  //
  // The retry queue is the right mechanism: the emailLog row already
  // holds the jobIds, so retry.js resends from there with a bounded
  // attempt count. The job stays remembered exactly once.
  if (eligible > 0 && sent === 0) {
    log.warn("all sends failed — queued for retry", {
      queryId: String(query._id), jobs: jobs.length,
    });
  }

  return sent;
}
