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
import { collections } from "../../config/db.js";
import { sendAlert } from "./send.js";
import { dailyCap } from "./transport.js";
import * as Provider from "./providerHealth.js";
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

/**
 * One EMAIL per group.
 *
 * Grouped by SEALED BATCH where one exists, and only otherwise by
 * subscription. That ordering is the fix for an exactly-once bug: a
 * retry must send the same message the idempotency key describes, and
 * regrouping purely by subscription would sweep newly-queued
 * obligations into a batch the provider may already have accepted —
 * marking them delivered when they were never in it.
 *
 * An unsealed row is one nobody has tried yet; those form new batches
 * and get sealed before anything is sent.
 */
function groupForSending(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.batchId ? `batch:${row.batchId}` : `sub:${row.subscriptionId}`;
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

  /* Do not call a provider that is known to be refusing.

     A wrong password rejects every message identically, and trying the
     next one proves nothing except that the credential is still wrong.
     Obligations stay pending and nothing is claimed, so the moment
     somebody fixes the configuration the whole backlog goes out. */
  const provider = Provider.canSend(now);
  if (!provider.ok) {
    log.warn("mail provider is not accepting — obligations left pending", {
      state: provider.state, reason: provider.reason, until: provider.until,
    });
    return { sent: 0, failed: 0, deferred: true, provider: provider.state };
  }

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

  const groups = groupForSending(claimed);

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

    /* IS THIS STILL OWED? Asked immediately before sending, not assumed
       from the moment it was queued.

       An outbox row carries its own copy of the address, the label and
       the job — deliberately, so a retry three weeks later does not fail
       because the fourteen-day cache dropped the title. The cost of that
       independence is that the row cannot notice the watch being paused,
       the watch being deleted, or the account being closed. Cancellation
       covers those on the way out, but a row can be claimed in the
       moment between a person pressing Hold and that cancellation
       landing, and an admin deleting an account by a route that forgets
       to cancel would otherwise still email them.

       So the state is re-read once per message. One extra round trip per
       email, against the alternative of mailing somebody who asked us
       not to. */
    const [subscription, user] = await Promise.all([
      collections.subscriptions().findOne(
        { _id: first.subscriptionId }, { projection: { active: 1, userId: 1 } }),
      collections.users().findOne(
        { _id: first.userId }, { projection: { email: 1, verified: 1 } }),
    ]);

    if (!subscription || !subscription.active || !user || !user.verified) {
      const why = !subscription ? "the watch was deleted"
        : !subscription.active ? "the watch is on hold"
        : !user ? "the account was deleted"
        : "the address is not verified";
      await Outbox.cancel(ids, { reason: why, now });
      log.info("dropped a queued alert — it is no longer owed", {
        subscriptionId: String(first.subscriptionId), jobs: jobs.length, reason: why,
      });
      continue;
    }

    /* The CURRENT address, not the one copied in when the job was found.
       Somebody who changed their email between discovery and delivery
       should be mailed where they are now. */
    const to = user.email || first.email;

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

    /* SEAL BEFORE SENDING. After this line the set of obligations this
       message carries is fixed and written down, so a retry sends the
       same message under the same key rather than a larger one. */
    const { batchKey } = await Outbox.sealBatch(rows, { now });

    let res;
    try {
      res = await send({
        to, label: first.label, jobs,
        idempotencyKey: batchKey,
      });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    await EmailLog.settle(logId, { ok: res.ok, providerId: res.id, error: res.error });

    if (res.ok) {
      const wasBroken = Provider.health().state !== Provider.READY;
      Provider.noteSuccess();
      await Outbox.settleSent(ids, { providerMessageId: res.id ?? null, now });
      sent++;
      /* The credentials work again. Everything parked while they did not
         goes back in the queue — all of it, not just whatever happens to
         be claimed next, so fixing a key drains the whole backlog. */
      if (wasBroken) {
        const freed = await Outbox.unblockAll({ now });
        if (freed) log.info("provider is answering again — releasing what was held", { freed });
      }
      continue;
    }

    failed++;
    /* Tell the provider health what kind of failure this was, and stop
       the pass if it turns out to be the kind that will reject every
       remaining message identically. Working through two hundred rows to
       collect two hundred copies of the same authentication error is how
       the 43-attempt evening happened, only slower. */
    const verdict = Provider.noteFailure(res.error);
    const fatal = verdict !== Provider.READY;
    /* A configuration error is not a transient one. Retrying a wrong
       password on a schedule produced 43 attempts in one evening for the
       same handful of jobs; the row is parked until somebody fixes the
       credentials, and the reason is written on it. */
    /* A CONFIGURATION FAILURE IS HELD, NOT KILLED.

       This settled the batch DEAD, which contradicted the comment beside
       it and the commit message that introduced it. The effect was that
       the first batch to discover a wrong API key was destroyed outright
       while every batch after it was correctly held — the one case the
       provider pause exists for was the one case it could not save.

       DEAD means "we have decided never to deliver this". A typo in an
       environment variable is not that decision. */
    const attempts = first.attempts || 1;
    if (Provider.isConfigFailure(res.error)) {
      await Outbox.settleBlocked(ids, { error: res.error, now });
      log.error("mail configuration rejected — holding this message until it is fixed", {
        userId: String(first.userId),
        error: String(res.error || "").slice(0, 160),
      });
      break;    // every remaining message would fail identically
    }
    if (attempts >= MAX_ATTEMPTS) {
      await Outbox.settleDead(ids, { error: res.error, now });
      log.error("outbox message given up on after repeated failures", {
        userId: String(first.userId), attempts,
        error: String(res.error || "").slice(0, 160),
      });
      if (fatal) break;
      continue;
    }
    const wait = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
    await Outbox.settleRetry(ids, {
      error: res.error,
      nextAttemptAt: new Date(now.getTime() + wait * 60_000),
      now,
    });
    if (fatal) break;
  }

  if (sent || failed) {
    log.info("outbox drained", { sent, failed, groups: affordable.length });
  }
  return { sent, failed, deferred: false };
}
