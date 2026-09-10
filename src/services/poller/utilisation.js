// utilisation.js
//
// Whether the schedule everyone has asked for is arithmetically possible.
//
// LinkedIn is one serial lane. Every search that includes it takes a turn
// on that lane, and a turn costs whatever that search's crawl costs —
// measured, not assumed. If a search wants to be swept every five
// minutes and its crawl takes eighty seconds, it is asking for 80/300 of
// the lane, about 27%. Four such searches ask for more than the lane has.
//
//   U = Σ (serviceTime_q / interval_q)
//
// U < 1  the schedule fits, with 1 − U to spare.
// U ≈ 1  the lane is saturated: any hiccup pushes sweeps late and they
//        never catch up, because there is no idle time to catch up in.
// U > 1  the cadence is impossible. Not slow — impossible. Sweeps fall
//        further behind every cycle for ever, and the only thing anyone
//        sees is alerts arriving later and later for no stated reason.
//
// This is the number that decides whether "we support N users" is a
// claim or a hope, and it was never computed. The capacity section of
// docs/SCALING.md is arithmetic done by hand from two measurements; this
// is the same arithmetic done continuously from the real ones.
//
// It measures the LANE, not the process. Adding a second poller does not
// raise the ceiling, because the ceiling is one host's tolerance for
// being crawled — which is exactly why there is a lease making sure
// there is only ever one poller.

import { collections } from "../../config/db.js";
import { log } from "../../utils/logger.js";

/* Sources that share one serial lane and one host's patience. LinkedIn
   is the only one that matters today: it is three surface walks per
   search and by far the slowest, and it is the one that answers a crawl
   it dislikes by returning empty pages rather than an error. */
const LANE_SOURCE = "linkedin";

/**
 * What fraction of the LinkedIn lane the current schedule is asking for.
 *
 * Queries with no measured service time yet are skipped rather than
 * guessed at. A default would make U wrong in whichever direction the
 * default leaned, and being confidently wrong about this number is worse
 * than not having it — the whole point is to catch a schedule that
 * cannot work.
 */
export async function laneUtilisation() {
  const rows = await collections.queries()
    .find(
      { nextFetchAt: { $ne: null }, sources: LANE_SOURCE },
      { projection: { everyMinutes: 1, serviceMsAvg: 1, keywords: 1, geoId: 1 } }
    )
    .toArray();

  const measured = rows.filter((q) => Number.isFinite(q.serviceMsAvg) && q.everyMinutes > 0);
  const contributions = measured.map((q) => ({
    queryId: String(q._id),
    keywords: (q.keywords || []).join("+") || "everything",
    everyMinutes: q.everyMinutes,
    serviceMs: q.serviceMsAvg,
    share: q.serviceMsAvg / (q.everyMinutes * 60_000),
  })).sort((a, b) => b.share - a.share);

  const U = contributions.reduce((sum, c) => sum + c.share, 0);

  return {
    U,
    sweeping: rows.length,
    measured: measured.length,
    unmeasured: rows.length - measured.length,
    /* How many more searches of the CURRENT average shape would fit.
       Floor, not round: half a search does not fit. */
    headroom: contributions.length
      ? Math.max(0, Math.floor((1 - U) / (U / contributions.length)))
      : null,
    contributions,
  };
}

/**
 * Say so when the schedule stops being possible.
 *
 * Warns once per pass rather than per query. The failure this describes
 * is silent by nature — sweeps simply drift later — so the log line is
 * the only place it can surface until the admin page carries it.
 */
export async function reportUtilisation() {
  const u = await laneUtilisation();
  if (!u.measured) return u;

  const pct = Math.round(u.U * 100);
  if (u.U >= 1) {
    log.error("the requested sweep cadence is arithmetically impossible", {
      utilisation: `${pct}%`,
      lane: LANE_SOURCE,
      searches: u.measured,
      note: "one serial lane cannot exceed 100% — sweeps will fall further behind every cycle",
      worst: u.contributions.slice(0, 3).map(
        (c) => `${c.keywords} every ${c.everyMinutes}m costs ${Math.round(c.share * 100)}%`
      ),
    });
  } else if (u.U >= 0.8) {
    log.warn("the sweep lane is close to saturated", {
      utilisation: `${pct}%`, searches: u.measured, headroom: u.headroom,
    });
  } else {
    log.debug("sweep lane utilisation", { utilisation: `${pct}%`, headroom: u.headroom });
  }
  return u;
}
