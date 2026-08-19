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

export function headerState(watches, pollerEnabled) {
  const active = watches.filter((w) => w.active);

  // Soonest upcoming sweep among the watches that are actually running.
  const next = active
    .map((w) => w.q?.nextFetchAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .sort((a, b) => a - b)[0];

  return {
    watchCount: watches.length,
    activeCount: active.length,
    // "Sweeping" is a claim about the poller, not about intent.
    sweeping: pollerEnabled && active.length > 0,
    nextSweepAt: pollerEnabled && next ? next : null,
  };
}
