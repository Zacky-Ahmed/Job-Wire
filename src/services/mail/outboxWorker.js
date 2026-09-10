// outboxWorker.js
//
// The only thing in the app that calls a mail provider.
//
// Sending used to happen inside the sweep, which meant discovering jobs
// and delivering them shared a fate: a provider that was slow made the
// crawl slow, a provider that threw skipped the rest of the subscribers,
// and the daily cap — checked in the middle of a crawl — decided whether
// a batch of alerts existed at all. Now the sweep writes obligations and
// stops. This drains them.
//
// The separation buys three things that are hard to get any other way:
//
//   · the cap defers ONE message instead of a whole batch, because a row
//     that is not claimed simply stays pending;
//   · a crash costs a delay rather than an alert, because the row is
//     still there and still pending;
//   · retrying is a property of the row, not of a scan over the email
//     log, so a broken credential stops being retried every poller tick.

import * as Outbox from "../../models/outbox.js";
import * as EmailLog from "../../models/emailLog.js";
import { sendAlert } from "./send.js";
import { dailyCap } from "./transport.js";
import { log } from "../../utils/logger.js";

/* How many rows to look at in one pass. Not a send limit — the cap
   below is that. This only bounds how much is read at once so a large
   backlog is worked through in pieces rather than in one enormous
   claim. */
const SCAN = 200;

/* Retry backoff, in minutes, by attempt number. Deliberately not
   exponential-to-infinity: after the last one the row is dead and says
   so, because a message nobody will ever look at again should not sit
   in a queue pretending it might still arrive. */
const BACKOFF_MINUTES = [1, 5, 20, 60, 240];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** One row per recipient per job; one EMAIL per recipient per pass. */
function groupBySubscription(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.subscriptionId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  // Oldest obligation first, so a backlog drains in the order it built up.
  return [...groups.values()].sort(
    (a, b) => new Date(a[0].discoveredAt || 0) - new Date(b[0].discoveredAt || 0)
  );
}

/**
 * Drain what is due.
 *
 * `send` and `cap` are injectable because the branches that matter most
 * are otherwise unreachable in a test: what happens when the ceiling is
 * hit halfway through, and what happens when the provider refuses.
 * Production passes neither.
 */
export async function drainOutbox({ send = sendAlert, cap = null, now = new Date() } = {}) {
  /* Rows whose worker went away come back first.

     SENDING is not a resting state. A process killed between claiming a
     row and settling it would otherwise leave that row claimed for ever
     — the same permanent loss the outbox exists to prevent, moved one
     step later and much harder to notice. */
  const reclaimed = await Outbox.reclaimStale({ now });
  if (reclaimed) log.warn("outbox rows reclaimed from a worker that went away", { rows: reclaimed });

  const ceiling = cap ?? dailyCap();
  const spent = await EmailLog.countToday();
  const remaining = ceiling - spent;
  if (remaining <= 0) {
    /* Nothing is claimed, so nothing changes state. Everything owed
       stays pending and is offered again tomorrow. This is the whole
       difference between the ceiling meaning "later" and meaning
       "forget", and it costs one comparison. */
    log.warn("daily mail ceiling reached — obligations left pending, not dropped", {
      spent, cap: ceiling, owed: (await Outbox.counts()).pending,
    });
    return { sent: 0, failed: 0, deferred: true };
  }

  const claimed = await Outbox.claimBatch({ limit: SCAN, now });
  if (!claimed.length) return { sent: 0, failed: 0, deferred: false };

  const groups = groupBySubscription(claimed);

  /* Each group is one email and therefore one unit of the cap. Groups
     beyond the budget go straight back to pending rather than being sent
     late in the same pass: they were claimed only because claiming is
     what makes reading them safe, and returning them is free. */
  const affordable = groups.slice(0, remaining);
  const overflow = groups.slice(remaining).flat();
  if (overflow.length) {
    await Outbox.settleRetry(overflow.map((r) => r._id), {
      error: null, nextAttemptAt: now, now,
    });
    log.info("more owed than today's ceiling allows — the rest stay pending", {
      sending: affordable.length, heldBack: overflow.length,
    });
  }

  let sent = 0;
  let failed = 0;

  for (const rows of affordable) {
    const ids = rows.map((r) => r._id);
    const first = rows[0];
    const jobs = rows.map((r) => r.job);

    /* The email log still records the ATTEMPT. It is what the daily cap
       counts and what the admin page reports, and it is deliberately not
       the same table as the obligation: an obligation outlives its
       attempts, and conflating the two is how "we tried" and "they were
       told" became the same fact in the first place. */
    const logId = await EmailLog.open({
      userId: first.userId,
      queryId: first.queryId,
      jobIds: rows.map((r) => r.jobId),
    });

    let res;
    try {
      res = await send({ to: first.email, label: first.label, jobs });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    await EmailLog.settle(logId, { ok: res.ok, providerId: res.id, error: res.error });

    if (res.ok) {
      await Outbox.settleSent(ids, { providerMessageId: res.id ?? null, now });
      sent++;
      continue;
    }

    failed++;
    /* A configuration error is not a transient one. Retrying a wrong
       password on a schedule produced 43 attempts in one evening for the
       same handful of jobs; the row is parked until somebody fixes the
       credentials, and the reason is written on it. */
    const attempts = first.attempts || 1;
    if (EmailLog.isConfigError(res.error) || attempts >= MAX_ATTEMPTS) {
      await Outbox.settleDead(ids, { error: res.error, now });
      log.error("outbox message given up on", {
        userId: String(first.userId), attempts,
        reason: EmailLog.isConfigError(res.error) ? "mail configuration" : "out of attempts",
        error: String(res.error || "").slice(0, 160),
      });
      continue;
    }
    const wait = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
    await Outbox.settleRetry(ids, {
      error: res.error,
      nextAttemptAt: new Date(now.getTime() + wait * 60_000),
      now,
    });
  }

  if (sent || failed) {
    log.info("outbox drained", { sent, failed, groups: affordable.length });
  }
  return { sent, failed, deferred: false };
}
