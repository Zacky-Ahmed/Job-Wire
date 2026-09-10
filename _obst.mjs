import fs from "node:fs";
const p = "scripts/test-sources.js";
let s = fs.readFileSync(p, "utf8");
const o = `console.log(failed ? \`\n\${failed} failed\` : "\nall good");`;
const n = `console.log("\n=== an adapter reports what it DID, not just what it returned ===");

/* Health used to be one number: how many jobs the sweep ended up with.
   That number cannot tell a quiet board from a broken parser from one
   of LinkedIn's three surfaces going dark behind two that still work —
   all three read as "we saw fewer jobs", and only the first is fine. */
const { observer, normalize, checkPageShape, HEALTHY, DEGRADED } =
  await import("../src/services/sources/observe.js");

// A bare array is still valid, and is reported as inferred rather than
// claimed — seven adapters returned one yesterday.
const asArray = normalize([{ jobId: "x:1" }, { jobId: "x:2" }], { source: "x" });
check("a bare Job[] is accepted", asArray.jobs.length === 2 && asArray.observation.status === HEALTHY);
check("and marked as inferred, not reported", asArray.observation.reported === false);
check("with the counts it can infer and nothing it cannot",
  asArray.observation.parsedCount === 2 && asArray.observation.requests === null);

// THE CASE THIS EXISTS FOR: one surface collapses, the total holds up.
const partial = observer("linkedin")
  .surface("countryFeed", { ok: true, requests: 1, rawCount: 120, parsedCount: 120 })
  .surface("guestKeyword", { ok: false, requests: 1, error: "429 from the guest API" })
  .surface("jserp", { ok: true, requests: 1, rawCount: 8, parsedCount: 8 })
  .done(new Array(128).fill({ jobId: "linkedin:x" }));
check("a sub-surface collapse marks the observation degraded",
  partial.observation.status === DEGRADED);
check("even though the total job count is still high",
  partial.observation.parsedCount === 128,
  "128 jobs — an aggregate count would have called this a normal sweep");
check("and it says which surface, so the fix is findable",
  partial.observation.warnings.some((w) => w.includes("guestKeyword")));

// A recognised empty state is a real answer, not a fault.
const quiet = observer("keells")
  .surface("listing", { ok: true, requests: 1, rawCount: 0, parsedCount: 0 })
  .done([]);
check("zero jobs from a working surface is HEALTHY",
  quiet.observation.status === HEALTHY,
  "treating a quiet Sunday as a fault trains people to ignore the alarm");

// A standing property of a source must not read as a fault for ever.
const noted = observer("topjobs")
  .surface("area:SDQ", { ok: true, requests: 1, rawCount: 40, parsedCount: 12 })
  .note("coverage is partial: 3 of ~31 functional areas are crawled")
  .done([{ jobId: "topjobs:1" }]);
check("a standing note does not degrade a healthy sweep",
  noted.observation.status === HEALTHY && noted.observation.notes.length === 1,
  "or every observation is degraded for ever and the word stops meaning anything");

console.log("\n=== HTTP 200 is not the same as 'the page we parse' ===");

/* The failure a scraped source is most likely to have: the board changes
   its markup, keeps answering 200, our selectors match nothing, and the
   empty array reads as a quiet day — for ever, and plausibly. */
const realPage = "<html><body>" + "<table>" + "<tr>row</tr>".repeat(20) + "</table>" + "x".repeat(600) + "</body></html>";
check("a page with its container and rows, parsed, is fine",
  checkPageShape({ html: realPage, containerFound: true, rowsFound: 20, parsedCount: 20 }).ok);

check("a page with its container and NO rows is a real empty listing",
  checkPageShape({ html: realPage, containerFound: true, rowsFound: 0, parsedCount: 0 }).ok,
  "the board really can have no jobs today");

const drifted = checkPageShape({ html: realPage, containerFound: true, rowsFound: 20, parsedCount: 0 });
check("but rows we could not parse is drift, not a quiet day",
  !drifted.ok && /row shape has changed/.test(drifted.error), drifted.error);

const gone = checkPageShape({ html: realPage, containerFound: false, rowsFound: 0, parsedCount: 0 });
check("and a missing container is drift too",
  !gone.ok && /page shape has changed/.test(gone.error), gone.error);

const stub = checkPageShape({ html: "<html></html>", containerFound: true, rowsFound: 0, parsedCount: 0 });
check("a suspiciously short response is refused before it is believed",
  !stub.ok, stub.error);

console.log("\n=== a baseline decides what counts as unusual ===");
const { isAnomalous } = await import("../src/models/observations.js");
const base = { samples: 20, median: 100 };
check("a fifth of the usual is a collapse", isAnomalous(15, base) === true);
check("two thirds of the usual is a Tuesday", isAnomalous(65, base) === false);
check("and with too few samples it declines to have an opinion",
  isAnomalous(1, { samples: 2, median: 100 }) === null,
  "a false alarm on day one teaches people to ignore the alarm");
check("a surface that normally returns nothing cannot collapse",
  isAnomalous(0, { samples: 20, median: 0 }) === null);

console.log(failed ? \`\n\${failed} failed\` : "\nall good");`;
if (!s.includes(o)) { console.error("MISS"); process.exit(1); }
fs.writeFileSync(p, s.replace(o, n));
console.log("ok");
