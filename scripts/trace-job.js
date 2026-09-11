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
import { guardedFetch } from "../src/services/http/guardedFetch.js";
import { parseJobs, classifyResponse } from "../src/services/linkedin/parse.js";
import { urlFor, pageUrlFor } from "../src/services/sources/linkedin.js";
import * as Coverage from "../src/models/telemetryCoverage.js";
import * as SweepRuns from "../src/models/sweepRuns.js";

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
const discoveredAt = (rs) => (rs.length ? rs.map((r) => r.firstSeenAt).sort()[0] : null);
const gap = (a, b) =>
  a && b ? `${Math.round((new Date(b) - new Date(a)) / 1000)}s` : "—";

console.log(`\nTracing ${jobId}\n${"=".repeat(60)}`);

if (markSeen) {
  const seenAt = new Date();
  console.log(`\nRecorded: you can see this on linkedin.com at ${fmt(seenAt)}`);

  /* THE SYNCHRONISED COMPARISON, which is the whole point of the flag.

     Recording only "the operator saw it at 14:02" leaves the question
     open, because we would not know what OUR surfaces held at 14:02 —
     only what they held at the last scheduled sweep, minutes either
     side. So the moment a sighting is reported, ask all three public
     surfaces right now, and the posting page itself.

     Then the two observations are seconds apart and the comparison is
     real:

       you see it  +  a public surface has it   -> OUR delay
       you see it  +  no public surface has it  -> THEIR exposure lag

     Those have opposite fixes, which is exactly why guessing between
     them ends with crawling harder against a lag that was never ours.

     DIAGNOSTIC ONLY. Nothing here writes seenJobs, touches the ledger,
     claims a job, or can cause an email. It reads four pages and writes
     one marker. */
  const geo = process.env.TRACE_GEO || "100446352";
  const kw = process.env.TRACE_KEYWORDS || "intern";
  const probe = {};

  const look = async (url) => {
    const startedAt = Date.now();
    try {
      const html = await guardedFetch(url, ["www.linkedin.com", "linkedin.com"], { jitter: true });
      const shape = classifyResponse(html);
      if (shape === "empty" || shape === "unrecognised") {
        return { present: false, shape, ms: Date.now() - startedAt };
      }
      const ids = parseJobs(html, new Date()).map((j) => j.jobId);
      return { present: ids.includes(jobId), rows: ids.length, shape, ms: Date.now() - startedAt };
    } catch (err) {
      return { present: null, error: err.message, ms: Date.now() - startedAt };
    }
  };

  console.log("\nAsking our public surfaces the same question, right now...\n");
  /* Page 0 only. This is a spot check against a reported sighting, not a
     crawl — walking 22 pages here would spend a whole sweep's requests
     every time a job is reported. A "not on page 0" is reported as such
     rather than as "not present". */
  probe.countryFeed = await look(urlFor({ geoId: geo, page: 0 }));
  probe.guestKeyword = await look(urlFor({ geoId: geo, keywords: kw, page: 0 }));
  probe.jserp = await look(pageUrlFor({ geoId: geo, keywords: kw, page: 0 }));

  try {
    const detail = await guardedFetch(
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/" + encodeURIComponent(bare),
      ["www.linkedin.com", "linkedin.com"], { jitter: true }
    );
    probe.detailPage = { present: detail.length > 500, bytes: detail.length };
  } catch (err) {
    probe.detailPage = { present: null, error: err.message };
  }

  for (const [name, r] of Object.entries(probe)) {
    const verdict = r.present === true ? "HAS IT"
      : r.present === false ? "not on page 0"
      : "could not tell";
    console.log(
      `  ${name.padEnd(13)} ${verdict.padEnd(16)}` +
      (r.rows !== undefined ? ` ${r.rows} rows` : "") +
      (r.bytes !== undefined ? ` ${r.bytes} bytes` : "") +
      (r.error ? `  ${String(r.error).slice(0, 50)}` : "")
    );
  }

  const anySurface = ["countryFeed", "guestKeyword", "jserp"].some((k) => probe[k]?.present === true);
  console.log(
    anySurface
      ? "\n  -> A public surface HAS this job while you are looking at it.\n" +
        "     Any delay from here is OURS: scheduling, crawl depth, or a degraded sweep."
      : "\n  -> No public surface has it on PAGE 0 while you are looking at it.\n" +
        "     Either it sits deeper than page 0 — matching jobs live on country-feed\n" +
        "     pages 18-21, measured — or the guest endpoints have not exposed it yet.\n" +
        "     The logged-in site is ranked with your own member data and is not the\n" +
        "     same result set; no scheduler can fix that half."
  );

  await collections.manualSightings().insertOne({
    jobId, seenAt, note: "operator saw this on linkedin.com", probe, geo, keywords: kw,
  });
  console.log("");
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
  for (const s of sightings) {
    console.log(`  ${fmt(s.seenAt)}`);
    if (!s.probe) continue;
    for (const [name, r] of Object.entries(s.probe)) {
      console.log(
        `      ${name.padEnd(13)} ` +
        (r.present === true ? "HAD IT" : r.present === false ? "not on page 0" : "could not tell")
      );
    }
  }
}

/* EVERY SWEEP IN BETWEEN, AND WHETHER IT WAS WORTH ANYTHING.

   "The scheduler ran every five minutes" and "we had five-minute
   information" are different claims. A sweep that started on time and
   came back degraded is not an observation, and a job that survived
   four degraded sweeps before being found on the fifth looks identical
   to a scheduler that was never running. This is what tells them
   apart — and it is the difference between fixing the crawler and
   fixing the schedule. */
const windowFrom = sightings.length ? sightings[0].seenAt : (job?.postedAt || null);
const windowTo = discoveredAt(rows);
if (windowFrom && windowTo) {
  const between = await collections.crawlLog()
    .find(
      { source: "linkedin", startedAt: { $gte: new Date(windowFrom), $lte: new Date(windowTo) } },
      { projection: { pages: 0 } }
    )
    .sort({ startedAt: 1 })
    .toArray();
  /* CAN ABSENCE MEAN ANYTHING HERE?

     This block previously printed "the crawler did not walk LinkedIn at
     all in that window" whenever it found no rows. The first real job it
     was run against had a window six hours older than the crawl log
     itself, so there could not have been a row — and the sentence went
     upward as a scheduling finding. A diagnostic that cannot tell "it
     did not happen" from "nobody was writing it down" is worse than no
     diagnostic, because it manufactures confident wrong answers. */
  const cov = await Coverage.coverage("crawlLog", windowFrom, windowTo);
  const runs = await SweepRuns.inWindow(windowFrom, windowTo);

  console.log(`\n-- every LinkedIn walk between then and discovery (${between.length}) --`);
  if (!cov.covered) {
    console.log(`  INCONCLUSIVE — ${cov.reason}.`);
    console.log("  Nothing can be concluded about this window. It is not evidence that");
    console.log("  the crawler did or did not run; we simply were not recording.");
  } else if (!between.length && !runs.length) {
    console.log("  none, and telemetry DID cover this window.");
    console.log("  No query sweep started either, so the scheduler never selected this");
    console.log("  search — a cadence or subscription answer, not an exposure one.");
  } else if (!between.length && runs.length) {
    console.log(`  none — but ${runs.length} query sweep(s) DID run in this window.`);
    console.log("  So the scheduler was working and LinkedIn was never attempted, or was");
    console.log("  attempted and failed before any page was walked. See the sweeps below.");
  }
  for (const w of between) {
    console.log(
      `  ${fmt(w.startedAt)}  ${String(w.surface).padEnd(13)} ` +
      `${String(w.requests).padStart(2)} req  ${String(Math.round(w.serviceMs / 1000)).padStart(3)}s  ` +
      `${w.ok ? "ok" : "FAILED"}  stopped: ${w.stopReason}` +
      (w.queueDelayMs ? `  (${Math.round(w.queueDelayMs / 1000)}s late)` : "")
    );
  }

  /* THE LEVEL ABOVE THE SURFACES. Crawl rows cannot distinguish "the
     query was never selected" from "it was selected and LinkedIn failed
     before a page was walked" — both are simply no rows. */
  if (runs.length) {
    console.log(`\n-- query sweeps in the same window (${runs.length}) --`);
    for (const r of runs) {
      const li = r.sources?.linkedin;
      console.log(
        `  ${fmt(r.startedAt)}  query ${String(r.queryId).slice(-6)}  ` +
        `${String(r.status).padEnd(8)}` +
        (r.queueDelayMs != null ? `  ${Math.round(r.queueDelayMs / 1000)}s late` : "") +
        (r.queuePosition != null ? `  #${r.queuePosition} of ${r.dueTotal} due` : "") +
        `  linkedin: ${li ? li.status : "NOT ATTEMPTED"}` +
        (li?.error ? `  ${String(li.error).slice(0, 40)}` : "")
      );
    }
  }
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
const discovered = discoveredAt(rows);
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
