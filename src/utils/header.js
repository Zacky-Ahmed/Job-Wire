// header.js
//
// What the top bar says, computed once so two pages cannot disagree.
//
// They did disagree. The chip read "Sweeping" whenever any watch was
// active, with no reference to whether the poller was actually running —
// so with POLLER_ENABLED off the header claimed to be sweeping while the
// stat card two inches below it said "Off".
//
// The countdown had a worse version of the same problem: ticker.js
// derived it from [data-next] elements, which only exist on the watches
// page, so on the wire — the page people actually sit on — "Next" was
// permanently "—". The server knows the answer; it should just say it.

/**
 * @param runtime the pollerRuntime() snapshot, or null when it could
 *   not be read. NOT a boolean, and that is the fix.
 *
 * This took `pollerEnabled` and computed
 * `sweeping: pollerEnabled && active.length > 0` — configuration plus a
 * count of watches, with no reference to whether the poller was doing
 * anything. The comment above claims that exact bug was fixed; it was
 * fixed in the admin panel and not here. So a real screenshot showed
 * the chip saying "Sweeping" while the card below it said "Stalled" and
 * the row below THAT said "standby", all at the same instant, because
 * three definitions were in play.
 *
 * One snapshot decides now, and the chip simply prints it.
 */
export function headerState(watches, runtime) {
  const active = watches.filter((w) => w.active);
  const pollerEnabled = runtime ? runtime.enabled : false;

  // Soonest upcoming sweep among the watches that are actually running.
  const next = active
    .map((w) => w.q?.nextFetchAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .sort((a, b) => a - b)[0];

  return {
    watchCount: watches.length,
    activeCount: active.length,
    /* "Sweeping" is a claim about the poller, so it comes from the
       poller. A reader with watches and a dead crawler must not be told
       their searches are running. */
    sweeping: runtime?.status === "WORKING",
    pollerLabel: runtime?.label ?? "Unknown",
    pollerTone: runtime?.tone ?? "sig",
    pollerHealthy: runtime?.healthy ?? false,
    nextSweepAt: pollerEnabled && next ? next : null,
  };
}
