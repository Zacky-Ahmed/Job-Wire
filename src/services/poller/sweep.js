// sweep.js
//
// One query, end to end: build the URL, fetch, parse, diff, fan out to
// every subscriber, reschedule.
//
// One fetch serves every subscriber of the query — that is what keeps
// request volume to LinkedIn flat as users grow.

import { buildGuestUrl } from "../linkedin/buildUrl.js";
import { fetchLinkedIn, BlockedByLinkedIn } from "../linkedin/fetch.js";
import { parseJobs, classifyResponse } from "../linkedin/parse.js";
import { diff } from "./dedupe.js";
import * as Queries from "../../models/queries.js";
import * as Subs from "../../models/subscriptions.js";
import * as EmailLog from "../../models/emailLog.js";
import { collections } from "../../config/db.js";
import { sendAlert } from "../mail/send.js";
import { dailyCap } from "../mail/transport.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";


export async function sweepQuery(query) {
  const started = Date.now();

  // The guest endpoint pages 10 at a time. With a 24h window a busy
  // market returns ~30, so page 1 alone would silently ignore the rest.
  // Sorted newest-first, so we stop as soon as a page adds nothing new.
  const PAGE_SIZE = 10;
  const MAX_PAGES = 4;
  const fetchedMap = new Map();

  for (let p = 0; p < MAX_PAGES; p++) {
    const url = buildGuestUrl({
      keywords: query.keywords,
      geoId: query.geoId,
      sweepMinutes: query.everyMinutes,
      start: p * PAGE_SIZE,
    });

    let html;
    try {
      html = await fetchLinkedIn(url, { jitter: p === 0 });
    } catch (err) {
      // Blocked: back off hard and exponentially. Everything else: short retry.
      const backoff =
        err instanceof BlockedByLinkedIn
          ? Math.min(120, query.everyMinutes * Math.pow(2, (query.failCount || 0) + 1))
          : query.everyMinutes * 2;
      await Queries.recordFailure(query._id, backoff);
      log.warn("sweep failed", {
        queryId: String(query._id), page: p, reason: err.name,
        message: err.message, backoffMin: backoff,
      });
      return { ok: false, error: err.message };
    }

    // "empty" is a healthy answer (nothing more to list) and must NOT be
    // treated as a failure, or every quiet query gets parked overnight.
    // "unrecognised" means a login wall or a markup change.
    const shape = classifyResponse(html);
    if (shape === "unrecognised") {
      await Queries.recordFailure(query._id, query.everyMinutes * 3);
      log.error("substantial response with no job markup — LinkedIn may have changed", {
        queryId: String(query._id), page: p, bytes: html.length,
      });
      return { ok: false, error: "unrecognised markup" };
    }
    if (shape === "empty") break;

    const jobs = parseJobs(html);
    if (!jobs.length) break;

    const before = fetchedMap.size;
    jobs.forEach((j) => fetchedMap.set(j.jobId, j));
    // A page that adds nothing means we have reached the end, or LinkedIn
    // is repeating itself. Either way, stop asking.
    if (fetchedMap.size === before) break;
  }

  const fetched = [...fetchedMap.values()];

  const { alertable, primed } = await diff(query, fetched);

  await Queries.reschedule(query._id, {
    everyMinutes: query.everyMinutes,
    primed: true,
    tracked: fetched.length,
  });

  log.info("sweep", {
    queryId: String(query._id),
    keywords: query.keywords.join("+"),
    fetched: fetched.length,
    new: alertable.length,
    priming: primed,
    ms: Date.now() - started,
  });

  if (primed || !alertable.length) return { ok: true, fetched: fetched.length, alerted: 0 };

  const alerted = await fanOut(query, alertable);
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
