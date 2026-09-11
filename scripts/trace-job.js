// trace-job.js
//
//   npm run trace-job -- https://www.linkedin.com/jobs/view/4123456789
//   npm run trace-job -- linkedin:4123456789
//   npm run trace-job -- 4123456789 --seen-now
//
// One delayed job, end to end: was LinkedIn late, or were we?
//
// This is the tool for the complaint that started this work — a watch
// set to five minutes, a job arriving twenty or thirty minutes after it
// is visible on linkedin.com. That gap contains four clocks and only two
// of them are ours, and until they are separated the only available move
// is to crawl more often, which spends requests against a lag that may
// never have been ours.
//
//   --seen-now records that YOU can see the job on linkedin.com at this
//   moment. That is the one timestamp nothing else can supply: by the
//   time a delayed job is noticed, "LinkedIn exposed it at 10:01" and
//   "LinkedIn exposed it at 10:28" look identical from the outside.
//   After twenty or thirty of these, the question is settled by data.
//
// Read-only apart from --seen-now, which writes a single marker. No
// authenticated browser automation, no account cookies: this inspects
// the same public surfaces the sweep already uses.

import "../src/config/env.js";
import { connectDb, closeDb, collections } from "../src/config/db.js";

const arg = process.argv[2];
const markSeen = process.argv.includes("--seen-now");

if (!arg) {
  console.error("usage: npm run trace-job -- <linkedin job url | linkedin:ID | ID> [--seen-now]");
  process.exit(1);
}

/* Accepts whatever is easiest to paste: a full URL off the address bar,
   a qualified id from a log line, or the bare number. */
const bare = String(arg).match(/(\d{6,})/)?.[1];
if (!bare) {
  console.error(`could not find a job id in "${arg}"`);
  process.exit(1);
}
const jobId = `linkedin:${bare}`;

await connectDb();

const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "—");
const gap = (a, b) =>
  a && b ? `${Math.round((new Date(b) - new Date(a)) / 1000)}s` : "—";

console.log(`\nTracing ${jobId}\n${"=".repeat(60)}`);

if (markSeen) {
  await collections.manualSightings().insertOne({
    jobId, seenAt: new Date(), note: "operator saw this on linkedin.com",
  });
  console.log(`\nRecorded: you can see this on linkedin.com at ${fmt(new Date())}`);
  console.log("That is the timestamp nothing else can supply. Thank you.\n");
}

const [rows, sightings, outbox, mail, walks] = await Promise.all([
  collections.seenJobs().find({ jobId }).toArray(),
  collections.manualSightings().find({ jobId }).sort({ seenAt: 1 }).toArray(),
  collections.outbox().find({ jobId }).sort({ createdAt: 1 }).toArray(),
  collections.emailLog().find({ jobIds: jobId }).sort({ sentAt: 1 }).toArray(),
  collections.crawlLog().find({ "pages.jobIds": jobId }).sort({ startedAt: 1 }).limit(40).toArray(),
]);

if (!rows.length && !walks.length) {
  console.log(
    `\nNothing recorded for this job at all.\n\n` +
    `That is itself an answer: no sweep has ever parsed it off a public surface.\n` +
    `If you can see it on linkedin.com right now, run again with --seen-now so the\n` +
    `moment is captured, and the next sweeps will show when our surfaces catch up.`
  );
  await closeDb();
  process.exit(0);
}

// ── what the job is ────────────────────────────────────────────
const job = rows[0];
if (job) {
  console.log(`\n${job.title}  ·  ${job.company}`);
  console.log(`${job.location || "?"}`);
  console.log(`LinkedIn says posted: ${fmt(job.postedAt)}  ("${job.postedText || "?"}")`);
  if (job.surfaces) console.log(`Seen by surfaces:     ${job.surfaces}   (F=country feed, G=guest keyword, J=JSERP)`);
}

// ── WHEN OUR SURFACES FIRST HAD IT ─────────────────────────────
console.log(`\n-- when our PUBLIC surfaces first carried it --`);
if (!walks.length) {
  console.log("  no crawl log covers this job (the log keeps 7 days, and starts");
  console.log("  from when this instrumentation shipped)");
} else {
  const firstBySurface = new Map();
  for (const w of walks) {
    const page = w.pages.find((p) => (p.jobIds || []).includes(jobId));
    if (!page) continue;
    const reachedAt = new Date(new Date(w.startedAt).getTime() + (page.atMs || 0));
    if (!firstBySurface.has(w.surface) || reachedAt < firstBySurface.get(w.surface).reachedAt) {
      firstBySurface.set(w.surface, { reachedAt, page: page.page, walk: w });
    }
  }
  for (const [surface, v] of firstBySurface) {
    console.log(
      `  ${surface.padEnd(13)} ${fmt(v.reachedAt)}  page ${String(v.page).padStart(2)}  ` +
      `(${Math.round((v.walk.serviceMs || 0) / 1000)}s walk, stopped: ${v.walk.stopReason})`
    );
  }
  /* The gap that matters most. The crawl reaching page 19 a minute into
     a walk is OUR minute; the surface not carrying it at all until the
     next sweep is LinkedIn's. */
  const earliest = [...firstBySurface.values()].sort((a, b) => a.reachedAt - b.reachedAt)[0];
  if (earliest) {
    console.log(
      `\n  earliest public sighting: ${fmt(earliest.reachedAt)} on ${[...firstBySurface.entries()]
        .find(([, v]) => v === earliest)[0]}, page ${earliest.page}`
    );
    const intoWalk = Math.round((earliest.reachedAt - new Date(earliest.walk.startedAt)) / 1000);
    console.log(`  which was ${intoWalk}s into that walk — that part of the delay is ours`);
  }
}

// ── WHAT YOU SAW ───────────────────────────────────────────────
if (sightings.length) {
  console.log(`\n-- when YOU saw it on linkedin.com --`);
  for (const s of sightings) console.log(`  ${fmt(s.seenAt)}`);
}

// ── OUR PIPELINE ───────────────────────────────────────────────
console.log(`\n-- what we then did with it --`);
for (const r of rows) {
  console.log(
    `  discovered   ${fmt(r.firstSeenAt)}  query ${String(r.queryId).slice(-6)}  ` +
    `matched=${r.matched} (${r.matchedBy || r.matchKind || "—"})` +
    (r.refinePending ? "  [still awaiting verification]" : "")
  );
}
for (const o of outbox) {
  console.log(
    `  queued       ${fmt(o.createdAt)}  status ${o.status}` +
    (o.sentAt ? `  sent ${fmt(o.sentAt)}` : "") +
    (o.lastError ? `  last error: ${String(o.lastError).slice(0, 60)}` : "")
  );
}
for (const m of mail) {
  console.log(`  emailed      ${fmt(m.sentAt)}  ${m.status}${m.error ? "  " + String(m.error).slice(0, 60) : ""}`);
}

// ── THE DECOMPOSITION ──────────────────────────────────────────
console.log(`\n-- where the time went --`);
const posted = job?.postedAt;
const discovered = rows.length ? rows.map((r) => r.firstSeenAt).sort()[0] : null;
const queued = outbox.length ? outbox[0].createdAt : null;
const sent = outbox.find((o) => o.sentAt)?.sentAt || (mail.length ? mail[0].sentAt : null);
const sighting = sightings.length ? sightings[0].seenAt : null;

/* READ THIS BEFORE TRUSTING THE FIRST LINE.

   postedAt is not independent evidence. LinkedIn gives a RELATIVE string
   — "35 minutes ago" — and parse.js resolves it against the instant we
   fetched the page. So "posted 08:11" really means "at 08:47 LinkedIn
   told us this was 35 minutes old".

   That number therefore contains BOTH the surface's exposure lag and our
   own reach lag, welded together, and it can never separate them. Only
   the crawl log above can: it records which of our walks carried the job
   and when, so "the guest surface had it at 08:20 and we did not reach
   that page until 08:47" becomes a fact rather than a theory.

   Until this job has walks in the log, treat the figure below as the
   size of the problem, not as an attribution of it. */
console.log(`  LinkedIn posted        ${fmt(posted)}   (derived from "${job?.postedText || "?"}" at fetch time)`);
if (sighting) console.log(`  you saw it             ${fmt(sighting)}   (+${gap(posted, sighting)})`);
console.log(`  we discovered it       ${fmt(discovered)}   (+${gap(posted, discovered)} after posting)`);
console.log(`  we queued the alert    ${fmt(queued)}   (+${gap(discovered, queued)} after discovery)`);
console.log(`  we sent it             ${fmt(sent)}   (+${gap(queued, sent)} after queueing)`);

if (sighting && discovered) {
  const ours = Math.round((new Date(discovered) - new Date(sighting)) / 1000);
  console.log(
    `\n  You could see it ${ours > 0 ? `${ours}s BEFORE we discovered it` : `${-ours}s AFTER we discovered it`}.`
  );
  if (ours > 120) {
    console.log(
      `  That gap is the one to explain. Check the surface timings above: if a\n` +
      `  public surface carried it during that window, the delay is ours. If none\n` +
      `  did, the public endpoints lagged your logged-in view and no scheduler can\n` +
      `  fix it — the logged-in site is ranked with your own member data and is not\n` +
      `  the same result set the guest surfaces expose.`
    );
  }
}

await closeDb();
process.exit(0);
