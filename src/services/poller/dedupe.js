// dedupe.js
//
// new = fetched − everything this search has ever seen.
//
// The priming rule is the whole reason this file exists separately: on a
// query's FIRST sweep every currently-listed job looks new. Alerting on
// them means the user's first ever email is a wall of stale posts. So the
// first sweep stores everything and sends nothing.
//
// What "ever seen" is measured against matters more than it looks. It used
// to be seenJobs, which expires after SEEN_JOB_TTL_DAYS to keep the wire a
// feed — so a posting a board left up for longer than that dropped out of
// the set, returned looking new, and was mailed a second time. It happened
// to 22 MAS listings at once. The ledger outlives the feed for exactly this
// reason; see models/alertedJobs.js.
//
// WHAT THIS FILE NO LONGER DOES: claim the ledger.
//
// It used to, right here, the moment a job was discovered — before the
// job had been matched, before anyone had been told. The argument was
// that claiming first costs at most one alert if something goes wrong,
// where claiming last risks two. That argument was wrong in one
// direction: a claimed job is never offered again, so "at most one
// alert" meant losing it permanently and silently, and it happened three
// different ways — a crash before matching, a crash before the email
// row, and an exception on one subscriber skipping all the rest.
//
// The claim now happens in sweep.js, after every intended recipient has
// a durable obligation in the outbox. The outbox's own uniqueness — one
// row per (subscription, job, channel) — is what stops the double alert
// this used to guard against, and it is a better guard because it is per
// recipient rather than per search.

import * as SeenJobs from "../../models/seenJobs.js";
import * as Ledger from "../../models/alertedJobs.js";

export async function diff(query, fetched) {
  const ids = fetched.map((j) => j.jobId);
  const known = await Ledger.knownIds(query._id, ids);
  const unseen = fetched.filter((j) => !known.has(j.jobId));

  // The wire's own copy. Its TTL is short on purpose and it has no say in
  // what counts as new.
  await SeenJobs.insertNew(query._id, unseen);

  if (!query.primed) {
    /* The priming sweep is the one place the claim still belongs here.

       Nothing is owed to anybody on this path — that is what priming
       means — so there is no gap between claiming and delivering to fall
       into. And the claim is not optional: leave these unclaimed and the
       NEXT sweep sees the board's entire back catalogue as new and mails
       all of it, which is the exact failure priming exists to prevent. */
    await Ledger.remember(query._id, unseen.map((j) => j.jobId));
    return { alertable: [], stored: unseen.length, primed: true, storedJobs: unseen };
  }
  return { alertable: unseen, stored: unseen.length, primed: false };
}
