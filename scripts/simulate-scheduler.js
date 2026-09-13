// simulate-scheduler.js
//
//   npm run simulate
//   npm run simulate -- 12          # simulate 12 hours instead of 6
//
// Six hours of Job Wire in a few milliseconds.
//
// Scheduler bugs are miserable to test in real time: you wait five
// minutes, then five more, and maybe something is wrong. The cost of
// that is not patience, it is that nobody runs the test, so scheduler
// changes get shipped on reasoning alone — which is how "every five
// minutes" quietly became "every fifteen" without a single failing
// assertion anywhere.
//
// So the clock is a variable. schedule.js is pure by design — no
// database, no Date.now(), no network — which means the real selection,
// fairness and capacity code can be driven against a virtual clock and
// artificial service times, and the questions that matter get answered
// in milliseconds:
//
//   which watches missed their deadlines, and by how much?
//   when did utilisation cross 100%?
//   did anybody starve?
//   what happens when the lease is lost mid-pass?
//
// No database, no network, no mail. This file never touches Mongo.

import {
  selectNext, nextSlot, utilisation, lateness,
  OVERSUBSCRIBED, NEAR_CAPACITY,
} from "../src/services/poller/schedule.js";

const HOURS = Number(process.argv[2]) || 6;
const MIN = 60_000;

/**
 * One run of the world.
 *
 * `queries` are plain descriptors: how often they want to be swept and
 * how long a sweep costs. `events` can interrupt — a lease lost, a
 * source slowing down — at a given virtual minute.
 */
function simulate({ name, queries, hours = HOURS, events = [] }) {
  const endAt = hours * 60 * MIN;
  let now = 0;

  /* The world's queries, shaped like the documents schedule.js expects,
     so the code under test is the real code and not a paraphrase. */
  const world = queries.map((q, i) => ({
    _id: q.id || `q${i}`,
    keywords: [q.id || `q${i}`],
    everyMinutes: q.everyMinutes,
    nextFetchAt: new Date(q.startAt ?? 0),
    lastFetchedAt: null,
    serviceMsAvg: q.serviceMs,
    /* Not used by schedule.js — the simulator's own knowledge of how
       long this query will actually take, which may differ from the
       rolling average the scheduler sees. */
    _trueServiceMs: q.serviceMs,
    _failing: !!q.failing,
  }));

  const byId = new Map(world.map((q) => [String(q._id), q]));
  const sweeps = [];
  const missedSlots = new Map();
  let utilisationCrossedAt = null;

  const fire = (t) => {
    for (const e of events) {
      if (e.atMinute * MIN <= t && !e._done) {
        e._done = true;
        e.apply(byId, world);
      }
    }
  };

  /* THE LOOP UNDER TEST: select one, sweep it, reschedule, select
     again. Not "take ten and walk the list". */
  let guard = 0;
  while (now < endAt && guard++ < 200_000) {
    fire(now);

    const u = utilisation(world);
    if (u.U > 1 && utilisationCrossedAt == null) utilisationCrossedAt = now;

    const pick = selectNext(world, now);
    if (!pick) {
      /* Nothing due. Jump straight to the next deadline rather than
         ticking — the whole point of virtual time. */
      const nextDue = world
        .map((q) => (q.nextFetchAt ? new Date(q.nextFetchAt).getTime() : Infinity))
        .reduce((a, b) => Math.min(a, b), Infinity);
      if (!Number.isFinite(nextDue) || nextDue <= now) break;
      now = Math.min(nextDue, endAt);
      continue;
    }

    const q = byId.get(String(pick.query._id));
    const scheduledFor = new Date(q.nextFetchAt).getTime();
    const startedAt = now;
    const serviceMs = q._trueServiceMs;
    const finishedAt = startedAt + serviceMs;

    const slot = nextSlot({
      scheduledFor: q.nextFetchAt,
      intervalMs: q.everyMinutes * MIN,
      now: finishedAt,
    });

    sweeps.push({
      id: String(q._id),
      scheduledFor, startedAt, finishedAt,
      queueDelayMs: startedAt - scheduledFor,
      serviceMs,
      reason: pick.reason,
      missed: slot.missed,
    });
    if (slot.missed) {
      missedSlots.set(String(q._id), (missedSlots.get(String(q._id)) || 0) + slot.missed);
    }

    q.lastFetchedAt = new Date(finishedAt);
    q.nextFetchAt = slot.at;
    now = finishedAt;
  }

  return { name, hours, world, sweeps, missedSlots, utilisationCrossedAt, final: utilisation(world) };
}

// ── reporting ──────────────────────────────────────────────────
const mmss = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const pct = (n) => `${Math.round(n * 100)}%`;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function report(r) {
  console.log(`\n${"═".repeat(66)}\n${r.name}   (${r.hours}h simulated)\n${"═".repeat(66)}`);

  const u = r.final;
  console.log(
    `lane utilisation   ${pct(u.U)}  ${u.state}` +
    (u.state === OVERSUBSCRIBED && u.sustainableMinutes
      ? `   sustainable cadence ~${u.sustainableMinutes}m`
      : "")
  );
  if (r.utilisationCrossedAt != null) {
    console.log(`crossed 100% at    ${mmss(r.utilisationCrossedAt)} of simulated time`);
  }
  console.log(`sweeps completed   ${r.sweeps.length}\n`);

  console.log(`  query        sweeps   delay p50    delay p90    worst     missed slots`);
  for (const q of r.world) {
    const mine = r.sweeps.filter((s) => s.id === String(q._id));
    const delays = mine.map((s) => s.queueDelayMs);
    const worst = delays.length ? Math.max(...delays) : 0;
    console.log(
      `  ${String(q._id).padEnd(12)} ${String(mine.length).padStart(5)}   ` +
      `${mmss(percentile(delays, 0.5)).padStart(9)}    ` +
      `${mmss(percentile(delays, 0.9)).padStart(9)}    ` +
      `${mmss(worst).padStart(7)}   ` +
      `${String(r.missedSlots.get(String(q._id)) || 0).padStart(6)}`
    );
  }

  /* STARVATION is the failure the fairness rule exists to prevent, so
     it is checked rather than eyeballed. A query that never ran at all
     in six simulated hours is the loudest possible version of it. */
  const never = r.world.filter((q) => !r.sweeps.some((s) => s.id === String(q._id)));
  if (never.length) {
    console.log(`\n  STARVED: ${never.map((q) => q._id).join(", ")} — never swept once`);
  }
  const byReason = r.sweeps.reduce((m, s) => m.set(s.reason, (m.get(s.reason) || 0) + 1), new Map());
  if (byReason.get("starving")) {
    console.log(`\n  ${byReason.get("starving")} sweeps were promoted by the starvation rule`);
  }
  return r;
}

// ── the scenarios ──────────────────────────────────────────────

/* THREE FIT, FOUR DO NOT. The arithmetic: a LinkedIn sweep is 78-92
   seconds measured, so at 80s a five-minute cadence costs 80/300 of the
   lane — 27%. Three searches is 80%; four is 107% and cannot be met by
   any scheduler, however clever. */
report(simulate({
  name: "3 × five-minute LinkedIn watches (80s each) — should fit",
  queries: [
    { id: "intern", everyMinutes: 5, serviceMs: 80_000 },
    { id: "data", everyMinutes: 5, serviceMs: 80_000 },
    { id: "supply", everyMinutes: 5, serviceMs: 80_000 },
  ],
}));

report(simulate({
  name: "4 × five-minute LinkedIn watches (80s each) — cannot fit",
  queries: [
    { id: "intern", everyMinutes: 5, serviceMs: 80_000 },
    { id: "data", everyMinutes: 5, serviceMs: 80_000 },
    { id: "supply", everyMinutes: 5, serviceMs: 80_000 },
    { id: "finance", everyMinutes: 5, serviceMs: 80_000 },
  ],
}));

/* MIXED CADENCE. The hourly watch must still run. Ranking by raw
   lateness would let the five-minute watches, which are late far more
   often, push it out for ever. */
report(simulate({
  name: "fast and slow together — the hourly watch must not starve",
  queries: [
    { id: "intern-5m", everyMinutes: 5, serviceMs: 80_000 },
    { id: "intern-5m-b", everyMinutes: 5, serviceMs: 80_000 },
    { id: "weekly-60m", everyMinutes: 60, serviceMs: 80_000 },
  ],
}));

/* ONE EXPENSIVE QUERY. A sweep that costs four minutes on a five-minute
   cadence is 80% of the lane by itself. Everything else must still get
   a turn. */
report(simulate({
  name: "one very expensive watch beside two cheap ones",
  queries: [
    { id: "expensive", everyMinutes: 5, serviceMs: 240_000 },
    { id: "cheap-a", everyMinutes: 5, serviceMs: 8_000 },
    { id: "cheap-b", everyMinutes: 15, serviceMs: 8_000 },
  ],
}));

/* A QUERY ARRIVING MID-PASS. Under the old frozen list it would have
   waited for the whole ten-query walk; here it becomes eligible the
   moment the running sweep finishes. */
report(simulate({
  name: "a new watch is created while another sweep is running",
  queries: [
    { id: "existing", everyMinutes: 5, serviceMs: 80_000 },
  ],
  events: [{
    atMinute: 2,
    apply: (byId, world) => {
      world.push({
        _id: "arrived", keywords: ["arrived"], everyMinutes: 5,
        nextFetchAt: new Date(2 * MIN), lastFetchedAt: null,
        serviceMsAvg: 80_000, _trueServiceMs: 80_000,
      });
      byId.set("arrived", world[world.length - 1]);
    },
  }],
}));

/* WAKING UP LATE. Twenty-five minutes of downtime owes ONE observation,
   not five crawls. A catch-up burst would aim five sweeps at the one
   source that answers being hammered by going silent — to deliver jobs
   the single current sweep returns anyway. */
report(simulate({
  name: "25 minutes of downtime — must not queue a catch-up storm",
  hours: 1,
  queries: [
    { id: "intern", everyMinutes: 5, serviceMs: 80_000, startAt: -25 * MIN },
  ],
}));

console.log(
  `\n${"─".repeat(66)}\n` +
  `Read the "missed slots" column as the honest cost of an oversubscribed\n` +
  `lane: grid slots that went by unswept. They are counted, never queued.\n` +
  `A scheduler that queued them would send a burst at LinkedIn to fetch\n` +
  `jobs the next single sweep returns anyway.\n`
);

process.exit(0);
