// runtime.js
//
// What the poller is doing, decided in ONE place.
//
// A screenshot of the admin page showed all of this at once:
//
//   top bar        Sweeping
//   summary card   Stalled — no progress for 2 min
//   detail row     state standby · queue 1 · last pass 77.3s
//   badge          Not ticking
//
// Four labels, four different definitions, one poller. Two separate
// faults produced that:
//
// THE HEADER NEVER LOOKED AT THE POLLER. utils/header.js computed
// `sweeping: pollerEnabled && active.length > 0` — configuration plus a
// count of active watches. Its own comment says that exact bug was
// fixed; it was fixed in the admin panel and not here, so the chip said
// Sweeping whenever anybody had a watch, whatever the poller was doing.
//
// STANDBY WAS BEING READ AS DEATH. A process that does not hold the
// lease writes state:"standby" and returns WITHOUT stamping lastTickAt,
// so its tick age grew forever and the admin page called it stale after
// 90 seconds. Standby is a correct, healthy state — it means another
// process is crawling and this one is deliberately not — and it was
// being reported as a failure.
//
// AND THE STALL THRESHOLD IS NEARLY THE CRAWL TIME. A LinkedIn pass is
// 78-92 seconds, measured. "No progress for 2 minutes" is close enough
// to that to fire on a perfectly healthy long sweep. Progress has to be
// measured by whether the work is MOVING — pages completing — not by how
// long the whole operation has taken.
//
// So: one snapshot, one set of rules, rendered by both surfaces.

/** Explicit, so nothing has to infer a state from a timestamp. */
export const OFF = "OFF";             // POLLER_ENABLED is false
export const NEVER = "NEVER";         // no heartbeat has ever been written
export const OFFLINE = "OFFLINE";     // the heartbeat itself stopped — the worker is gone
export const STANDBY = "STANDBY";     // healthy, but another process holds the lease
export const WORKING = "WORKING";     // crawling, and making progress
export const OVERDUE = "OVERDUE";     // running, but behind its own schedule
export const STALLED = "STALLED";     // alive, holding an operation that has stopped moving
export const IDLE = "IDLE";           // nothing due

/* A worker that has not written a heartbeat in this long is gone. The
   loop beats several times per tick, so this is generous. */
const HEARTBEAT_GRACE_MS = 90_000;

/* How long an ACTIVE operation may make no measurable progress before
   it counts as stuck. Deliberately much larger than a whole LinkedIn
   pass: the question is not "has this taken a while", it is "has
   anything completed recently". A crawl that is fetching page 18 of 24
   is healthy however long it has been running. */
const NO_PROGRESS_MS = 6 * 60_000;

/**
 * @param beat  the pollerState heartbeat document
 * @param lease the current lease row, or null
 * @param opts  { enabled, owner } — this process's config and identity
 */
export function pollerRuntime(beat, lease, { enabled, owner = null, now = Date.now() } = {}) {
  const age = (d) => (d ? now - new Date(d).getTime() : null);

  const heartbeatAge = age(beat?.at || beat?.lastTickAt);
  /* The freshest sign of life from the WORK, as opposed to from the
     loop: a page completing, a query being claimed, a tick starting.
     Taking the newest of them is what stops a long crawl looking dead. */
  const progressAge = (() => {
    const candidates = [beat?.lastProgressAt, beat?.currentSince, beat?.lastTickAt]
      .map((d) => (d ? new Date(d).getTime() : 0))
      .filter(Boolean);
    return candidates.length ? now - Math.max(...candidates) : null;
  })();

  const snapshot = {
    enabled,
    state: beat?.state || "unknown",
    heartbeatAge,
    progressAge,
    queueDepth: beat?.queueDepth ?? null,
    dueTotal: beat?.dueTotal ?? null,
    lastPassMs: beat?.lastTickMs ?? null,
    currentQueryId: beat?.currentQueryId || null,
    currentSource: beat?.currentSource || null,
    currentSurface: beat?.currentSurface || null,
    currentPage: beat?.currentPage ?? null,
    leaseHolder: lease?.owner || null,
    leaseExpiresAt: lease?.expiresAt || null,
    isThisProcess: owner && lease?.owner === owner,
  };

  snapshot.status = decide(snapshot, beat, now);
  snapshot.healthy =
    snapshot.status === WORKING ||
    snapshot.status === STANDBY ||
    snapshot.status === IDLE ||
    snapshot.status === OVERDUE;
  snapshot.label = LABEL[snapshot.status];
  snapshot.detail = detail(snapshot, now);
  snapshot.tone = snapshot.status === OFF ? "amber" : snapshot.healthy ? "go" : "sig";
  return snapshot;
}

function decide(s, beat, now) {
  if (!s.enabled) return OFF;
  if (!beat || (!beat.at && !beat.lastTickAt)) return NEVER;

  /* The worker itself. Checked before anything about the work, because
     a dead process has no opinion worth reading about what it was
     doing when it died. */
  if (s.heartbeatAge > HEARTBEAT_GRACE_MS) return OFFLINE;

  /* STANDBY IS HEALTHY. Another process holds the lease and this one is
     correctly not crawling. It used to be judged on a tick age it never
     updates, and so declared stale after ninety seconds. */
  if (s.state === "standby") return STANDBY;

  if (s.state === "working") {
    /* Progress, not duration. A LinkedIn pass takes 78-92 seconds and
       may legitimately run longer; what makes it stuck is nothing
       COMPLETING, not the clock. */
    if (s.progressAge != null && s.progressAge > NO_PROGRESS_MS) return STALLED;
    if (beat.overdueMs > 0) return OVERDUE;
    return WORKING;
  }

  return IDLE;
}

const LABEL = {
  [OFF]: "Off",
  [NEVER]: "No tick",
  [OFFLINE]: "Offline",
  [STANDBY]: "Standby",
  [WORKING]: "Sweeping",
  [OVERDUE]: "Behind",
  [STALLED]: "Stalled",
  [IDLE]: "Idle",
};

function secs(ms) { return ms == null ? "?" : `${Math.round(ms / 1000)}s`; }

function detail(s, now) {
  switch (s.status) {
    case OFF:
      return "POLLER_ENABLED is false";
    case NEVER:
      return "no heartbeat recorded yet";
    case OFFLINE:
      return `no heartbeat for ${secs(s.heartbeatAge)} — the worker is gone`;
    case STANDBY: {
      /* Says WHO, and for how much longer. "Standby" on its own invites
         exactly the panic the old "Stalled" caused. */
      const left = s.leaseExpiresAt
        ? Math.max(0, new Date(s.leaseExpiresAt).getTime() - now)
        : null;
      return s.leaseHolder
        ? `another process is crawling (${s.leaseHolder}` +
          (left != null ? `, lease expires in ${secs(left)})` : ")")
        : "waiting for the crawl lease";
    }
    case STALLED:
      return `nothing has completed for ${secs(s.progressAge)}` +
        (s.currentSource ? ` — stuck on ${s.currentSource}` : "");
    case OVERDUE:
      return `running, but behind schedule · ${s.queueDepth ?? 0} queued`;
    case WORKING: {
      const where = [s.currentSource, s.currentSurface].filter(Boolean).join(" · ");
      return (where ? `${where}` : "sweeping") +
        (s.currentPage != null ? ` · page ${s.currentPage}` : "") +
        ` · last progress ${secs(s.progressAge)} ago`;
    }
    default:
      return s.dueTotal ? `${s.dueTotal} due` : "nothing due";
  }
}
