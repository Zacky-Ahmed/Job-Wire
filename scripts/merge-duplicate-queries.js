// merge-duplicate-queries.js
//
//   npm run merge-queries            -- report only
//   npm run merge-queries -- --apply
//
// Collapses query rows that are the same search.
//
// keywordsKey used to encode the source picker, so "intern", "intern@@linkedin"
// and "intern@@keells+linkedin" became three separate rows. Sources are now
// resolved from the country at sweep time, so all three fetch exactly the
// same thing — the shared-query design, whose entire point is that a hundred
// people watching one search cost one fetch, was silently not working.
//
// The cost is not theoretical. Sweeps run one at a time, so three copies of
// one search put two extra sweeps in front of everyone else's watch and
// stretched a five minute schedule to nine. One user was also receiving two
// identical emails for every job.
//
// Nobody loses a watch. Subscriptions are repointed at the surviving row;
// where that would give somebody the same watch twice, the redundant row is
// removed rather than the search.

import "../src/config/env.js";
import { connectDb, collections } from "../src/config/db.js";
import * as Subs from "../src/models/subscriptions.js";

const APPLY = process.argv.includes("--apply");
await connectDb();

/** Two queries are the same search if these agree. */
const identity = (q) =>
  JSON.stringify({
    words: (q.keywords || []).map((w) => String(w).toLowerCase().trim()).sort(),
    geoId: q.geoId,
    matchAll: !!q.matchAll,
  });

const all = await collections.queries().find({}).toArray();

const groups = new Map();
for (const q of all) {
  const k = identity(q);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(q);
}

let movedTotal = 0, removedTotal = 0, retiredTotal = 0;

for (const [, rows] of groups) {
  if (rows.length < 2) continue;

  /* Which row survives is decided by its KEY first, not its size.
     
     keywordsKey is what upsert() matches on when somebody creates a
     watch. The source picker is gone, so a new "intern / Sri Lanka"
     watch now produces the bare key "intern" — and if the survivor were
     "intern@@linkedin", that upsert would find the retired "intern" row,
     revive it, and split the search in two all over again. Keeping the
     row whose key a new watch would actually generate is what makes this
     merge stick.
     
     History is not the tiebreaker it appears to be: the wire scopes each
     watch by its own createdAt, so a reader only ever sees jobs found
     after they subscribed. The three rows here hold 3666, 3900 and 4089
     jobs and it makes no visible difference which one is kept. */
  const legacyKey = (q) => (String(q.keywordsKey).includes("@@") ? 1 : 0);
  const counted = [];
  for (const q of rows) {
    counted.push({
      q,
      live: await collections.subscriptions().countDocuments({ queryId: q._id, active: true }),
    });
  }
  counted.sort((a, b) =>
    legacyKey(a.q) - legacyKey(b.q) ||        // a key new watches will match
    b.live - a.live ||                        // then the most-watched
    a.q.createdAt - b.q.createdAt);           // then the oldest
  const keep = counted[0].q;
  const drop = counted.slice(1).map((c) => c.q);

  console.log(`\nsame search: ${JSON.stringify(keep.keywords)} / ${keep.geoId}` +
              `${keep.matchAll ? " (match all)" : ""}`);
  console.log(`  keeping   ${keep.keywordsKey}`);

  for (const d of drop) {
    console.log(`  folding   ${d.keywordsKey}`);
    const subs = await collections.subscriptions().find({ queryId: d._id }).toArray();

    for (const s of subs) {
      const user = await collections.users().findOne(
        { _id: s.userId }, { projection: { email: 1 } });
      const who = user?.email || String(s.userId);

      // Checked per subscription rather than up front: two rows belonging
      // to the same person both look movable until the first one lands.
      const existing = await collections.subscriptions().findOne({
        userId: s.userId, queryId: keep._id,
      });

      if (existing) {
        console.log(`     - ${who} already watches it — removing the duplicate row`);
        removedTotal++;
        if (APPLY) {
          // Keep the watch switched on if either copy was on.
          if (s.active && !existing.active) {
            await collections.subscriptions().updateOne(
              { _id: existing._id }, { $set: { active: true } });
          }
          await collections.subscriptions().deleteOne({ _id: s._id });
        }
      } else {
        console.log(`     - ${who} "${s.label}" -> repointed${s.active ? "" : " (paused)"}`);
        movedTotal++;
        if (APPLY) {
          await collections.subscriptions().updateOne(
            { _id: s._id }, { $set: { queryId: keep._id } });
        }
      }
    }

    retiredTotal++;
    // syncSchedule parks a query the moment nothing active points at it,
    // so the folded rows stop being swept without being deleted — their
    // seenJobs history expires on its own TTL.
    if (APPLY) await Subs.syncSchedule(d._id);
  }

  if (APPLY) await Subs.syncSchedule(keep._id);
}

console.log(`\nsubscriptions repointed : ${movedTotal}`);
console.log(`duplicate rows removed  : ${removedTotal}`);
console.log(`query rows retired      : ${retiredTotal}`);
console.log(APPLY ? "\napplied." : "\ndry run. re-run with -- --apply to write.");
process.exit(0);
