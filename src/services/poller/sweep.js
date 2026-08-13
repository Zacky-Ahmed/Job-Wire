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
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

const GMAIL_DAILY_CEILING = 450; // leave headroom under Gmail's ~500

export async function sweepQuery(query) {
  const started = Date.now();
  const url = buildGuestUrl({
    keywords: query.keywords,
    geoId: query.geoId,
    sweepMinutes: query.everyMinutes,
  });

  let html;
  try {
    html = await fetchLinkedIn(url);
  } catch (err) {
    // Blocked: back off hard and exponentially. Everything else: short retry.
    const backoff =
      err instanceof BlockedByLinkedIn
        ? Math.min(120, query.everyMinutes * Math.pow(2, (query.failCount || 0) + 1))
        : query.everyMinutes * 2;
    await Queries.recordFailure(query._id, backoff);
    log.warn("sweep failed", {
      queryId: String(query._id), reason: err.name, message: err.message, backoffMin: backoff,
    });
    return { ok: false, error: err.message };
  }

  // "empty" is a healthy answer (no jobs posted in the window) and must
  // NOT be treated as a failure, or every quiet query gets parked
  // overnight. "unrecognised" means a login wall or a markup change.
  const shape = classifyResponse(html);
  if (shape === "unrecognised") {
    await Queries.recordFailure(query._id, query.everyMinutes * 3);
    log.error("substantial response with no job markup — LinkedIn may have changed", {
      queryId: String(query._id), bytes: html.length,
    });
    return { ok: false, error: "unrecognised markup" };
  }

  const fetched = shape === "empty" ? [] : parseJobs(html);
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
  if (sentToday >= GMAIL_DAILY_CEILING) {
    log.warn("daily mail ceiling reached — alerts suppressed", { sentToday });
    return 0;
  }

  let sent = 0;
  for (const sub of subs) {
    const user = await collections.users().findOne(
      { _id: sub.userId },
      { projection: { email: 1, verified: 1 } }
    );
    // Never mail an address that was not confirmed.
    if (!user?.verified) continue;

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
  return sent;
}
