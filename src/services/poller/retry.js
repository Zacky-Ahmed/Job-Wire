// retry.js
//
// Re-sends alerts whose delivery failed.
//
// Without this, a transient SMTP problem loses the alert permanently:
// the job is already recorded in seenJobs, so no later sweep will
// rediscover it, and the user simply never hears about a job that was
// caught successfully. The catching worked; only the delivery broke.
//
// Runs on the poller's tick, a few at a time, so a backlog drains
// steadily instead of hammering Gmail in one burst.

import * as EmailLog from "../../models/emailLog.js";
import { collections } from "../../config/db.js";
import { sendAlert } from "../mail/send.js";
import { dailyCap } from "../mail/transport.js";
import { log } from "../../utils/logger.js";

export async function retryFailedSends() {
  const pending = await EmailLog.findRetryable({ maxAttempts: 3, olderThanMs: 60_000, limit: 5 });
  if (!pending.length) return 0;

  /* The cap is a PROVIDER limit, so every path that sends has to respect
     it. sweepQuery checked it before fanning out; this queue did not — so
     the moment the ceiling was reached, sweeps went quiet exactly as
     designed while the retry queue carried on hammering the same provider
     that had just refused. Which then failed, which queued more retries. */
  const sentToday = await EmailLog.countToday();
  if (sentToday >= dailyCap()) {
    log.warn("daily mail ceiling reached — retries deferred to tomorrow", { sentToday });
    return 0;
  }
  let budget = dailyCap() - sentToday;

  let recovered = 0;

  for (const entry of pending) {
    if (budget <= 0) {
      log.warn("hit the mail ceiling mid-retry — the rest wait for tomorrow");
      break;
    }
    const user = await collections.users().findOne(
      { _id: entry.userId },
      { projection: { email: 1, verified: 1 } }
    );
    if (!user?.verified) {
      // Nothing to retry to — close it out rather than looping forever.
      await EmailLog.markRetried(entry._id, { ok: false, error: "recipient not verified" });
      continue;
    }

    // Rebuild the job list from what we stored when we caught them. If a
    // job has since aged out of seenJobs (TTL) we simply send what is left.
    const jobs = await collections.seenJobs()
      .find({ queryId: entry.queryId, jobId: { $in: entry.jobIds || [] } })
      .toArray();

    if (!jobs.length) {
      await EmailLog.markRetried(entry._id, { ok: false, error: "jobs no longer stored" });
      continue;
    }

    /* The watch has to still exist AND still be on. Without active:true a
       paused watch kept receiving retries, and `sub?.label || "your watch"`
       meant a DELETED one did too, under a generic label — mail arriving
       after you switched something off is the kind of thing that gets an
       address marked as spam by hand. */
    const sub = await collections.subscriptions().findOne({
      userId: entry.userId, queryId: entry.queryId, active: true,
    });
    if (!sub) {
      await EmailLog.markRetried(entry._id, {
        ok: false, error: "watch paused or deleted before the retry ran",
      });
      continue;
    }

    budget--;
    const res = await sendAlert({ to: user.email, label: sub.label, jobs });

    await EmailLog.markRetried(entry._id, {
      ok: res.ok, providerId: res.id, error: res.error,
    });

    if (res.ok) {
      recovered++;
      log.info("retry delivered a previously failed alert", {
        to: user.email, jobs: jobs.length, attempt: (entry.attempts || 0) + 1,
      });
    } else if (EmailLog.isConfigError(res.error)) {
      // Held, not counted — it will keep waiting until someone fixes the
      // credentials, then deliver on the next tick.
      log.error("alert blocked by a configuration problem — fix and it will send itself", {
        to: user.email, message: res.error,
      });
    } else {
      log.warn("retry failed again", {
        to: user.email, attempt: (entry.attempts || 0) + 1, message: res.error,
      });
    }
  }

  return recovered;
}
