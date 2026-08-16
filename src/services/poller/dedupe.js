// dedupe.js
//
// new = fetched − seen.
//
// The priming rule is the whole reason this file exists separately: on a
// query's FIRST sweep every currently-listed job looks new. Alerting on
// them means the user's first ever email is a wall of stale posts. So the
// first sweep stores everything and sends nothing.

import * as SeenJobs from "../../models/seenJobs.js";

export async function diff(query, fetched) {
  const ids = fetched.map((j) => j.jobId);
  const known = await SeenJobs.knownIds(query._id, ids);
  const unseen = fetched.filter((j) => !known.has(j.jobId));

  // Priming: remember everything, alert on nothing.
  if (!query.primed) {
    await SeenJobs.insertNew(query._id, unseen);
    return { alertable: [], stored: unseen.length, primed: true, storedJobs: unseen };
  }

  // insertNew returns only what THIS call inserted, so a concurrent
  // sweep cannot cause two emails for one job.
  const inserted = await SeenJobs.insertNew(query._id, unseen);
  return { alertable: inserted, stored: inserted.length, primed: false };
}
