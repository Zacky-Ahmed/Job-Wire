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

import * as SeenJobs from "../../models/seenJobs.js";
import * as Ledger from "../../models/alertedJobs.js";

export async function diff(query, fetched) {
  const ids = fetched.map((j) => j.jobId);
  const known = await Ledger.knownIds(query._id, ids);
  const unseen = fetched.filter((j) => !known.has(j.jobId));

  /* Claimed before anything is sent, not after.
     
     The unique index decides the race: if two sweeps meet the same job,
     one insert loses and only the winner may alert. Claiming first also
     means a crash between here and the send costs at most one alert,
     rather than leaving the job unclaimed and mailing it twice — the same
     trade emailLog.open()/settle() already makes. */
  const claimed = await Ledger.remember(query._id, unseen.map((j) => j.jobId));
  const mine = unseen.filter((j) => claimed.has(j.jobId));

  // The wire's own copy. Its TTL is short on purpose and no longer has any
  // say in what counts as new.
  await SeenJobs.insertNew(query._id, mine);

  if (!query.primed) {
    return { alertable: [], stored: mine.length, primed: true, storedJobs: mine };
  }
  return { alertable: mine, stored: mine.length, primed: false };
}
