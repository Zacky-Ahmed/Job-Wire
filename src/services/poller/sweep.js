// sweep.js
//
// One query, end to end: build the URL, fetch, parse, diff, fan out to
// every subscriber, reschedule.
//
// One fetch serves every subscriber of the query — that is what keeps
// request volume to LinkedIn flat as users grow.

import { getSource, DEFAULT_SOURCE } from "../sources/index.js";
import { BlockedBySource } from "../http/guardedFetch.js";
import { diff } from "./dedupe.js";
import * as Queries from "../../models/queries.js";
import * as SeenJobs from "../../models/seenJobs.js";
import * as Subs from "../../models/subscriptions.js";
import * as EmailLog from "../../models/emailLog.js";
import { collections } from "../../config/db.js";
import { sendAlert } from "../mail/send.js";
import { dailyCap } from "../mail/transport.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";


export async function sweepQuery(query) {
  const started = Date.now();

  // A watch can span several sources. Each is fetched independently so
  // one site being down or blocked does not cost you the others — a
  // failure is recorded per source, and the sweep still delivers whatever
  // the working ones found.
  const sourceIds = query.sources?.length ? query.sources : [DEFAULT_SOURCE];
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
    const words = (query.matchAll ? [] : query.keywords).map((w) => w.toLowerCase());
    const obvious = (storedJobs || []).filter(
      (j) => !words.length || words.some((n) => j.title.toLowerCase().includes(n))
    );
    await SeenJobs.markMatched(query._id, obvious.map((j) => ({ ...j, matchedBy: "title" })));
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }
  if (!alertable.length) return { ok: true, fetched: fetched.length, alerted: 0 };

  // Decide what the watch actually wants, now that the list is down to
  // jobs we have never seen. This is where a source may spend a request
  // per job to read details a results page does not carry — affordable
  // here, ruinous if it ran over the whole feed every sweep.
  //
  // Everything fetched is already recorded as seen, so a job rejected
  // here is rejected once and never reconsidered.
  let wanted = alertable;
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

  await SeenJobs.markMatched(query._id, wanted);

  if (!wanted.length) {
    log.info("sweep found new jobs but none matched the watch", {
      queryId: String(query._id), considered: alertable.length,
    });
    return { ok: true, fetched: fetched.length, alerted: 0 };
  }

  const alerted = await fanOut(query, wanted);
  return { ok: true, fetched: fetched.length, alerted };
}

/** One email per subscriber per sweep, carrying every new job at once. */
async function fanOut(query, jobs) {
  const subs = await Subs.activeSubscribers(query._id);
  if (!subs.length) return 0;

  const sentToday = await EmailLog.countToday();
  if (sentToday >= dailyCap()) {
    log.warn("daily mail ceiling reached — alerts suppressed", { sentToday });
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
    eligible++;

    const res = await sendAlert({ to: user.email, label: sub.label, jobs });
    await EmailLog.record({
      userId: sub.userId,
      queryId: query._id,
      jobIds: jobs.map((j) => j.jobId),
      status: res.ok ? "sent" : "failed",
      providerId: res.id,
      error: res.error,
    });
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
