// test-sources.js
//
//   npm run test-sources
//
// Adapter rules that can be checked without a database, a network, or a
// mail provider — so this is safe to run anywhere, unlike e2e, which
// still talks to a real Mongo.
//
// Everything here exists because an outside review of the code claimed a
// bug. Three of the five it named were already fixed; these tests are so
// that the next review's answer comes from a run rather than from
// somebody re-reading the file.

import { inSriLanka } from "../src/services/sources/rooster.js";
import * as rooster from "../src/services/sources/rooster.js";
import * as keells from "../src/services/sources/keells.js";
import { matchesAny } from "../src/utils/match.js";
import { listSources, getSource } from "../src/services/sources/index.js";
import { readFileSync } from "node:fs";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const all = (label, cases, fn) => {
  const bad = cases.filter((c) => !fn(c));
  check(label, bad.length === 0, bad.length ? "failed on: " + JSON.stringify(bad) : `(${cases.length})`);
};

console.log("\n=== Rooster: which locations count as Sri Lanka ===");

/* Every one of these is a real label from a 481-row snapshot of the
   live API, not an invented example. */
all("a label naming the country is kept", [
  "Colombo, Sri Lanka",
  "Colombo 03, Colombo, Sri Lanka",
  "Sri Lanka",
  "Battaramulla, Sri Lanka",
], inSriLanka);

all("a foreign label is refused", [
  "Qatar",
  "Mumbai, Maharashtra, India",
  "Islamabad, Pakistan",
  "Sydney NSW, Australia",
  "Cairo, Cairo Governorate, Egypt",
  "Malé, Maldives",
  "Dubai Investment Park Second - Dubai - United Arab Emirates",
  "Stanford-le-Hope SS17, UK",
], (l) => !inSriLanka(l));

/* The old rule named five cities and no more. It was not losing jobs,
   but only because nothing in that snapshot was posted as a bare city
   outside those five — and a bare city IS how one row arrived. */
all("a bare Sri Lankan town with no country is kept", [
  "Colombo", "Matara", "Kurunegala", "Batticaloa", "Nuwara Eliya", "Ja-Ela",
], inSriLanka);

/* The reason the city list may only be consulted when nothing names a
   country. There is a Colombo Street in Christchurch. */
check("a foreign address containing a Sri Lankan place name is still refused",
  !inSriLanka("Colombo Street, Christchurch, New Zealand"));
check("and so is a Galle Road that is not in Sri Lanka",
  !inSriLanka("Galle Court, Melbourne VIC, Australia"));

/* 18 rows of the measured snapshot. Open to anyone, so open to us — and
   the location string says so on its own, which is why no extra label
   is rendered anywhere. */
all("worldwide-remote is kept, because a Sri Lankan can take it", [
  "Anywhere, Worldwide", "Worldwide", "Remote",
], inSriLanka);

check("an empty location is not treated as Sri Lankan",
  !inSriLanka("") && !inSriLanka(null) && !inSriLanka(undefined));

console.log("\n=== Rooster: pagination reaches the end of the board ===");

/* The board declares five pages of a hundred. The sweep used to cap
   every adapter at four, so the fifth page — roughly a hundred of
   Rooster's ~490 listings — could never be requested. */
check("the adapter declares its own page budget", rooster.maxPages === 5, `maxPages=${rooster.maxPages}`);
check("and its page size", rooster.pageSize === 100, `pageSize=${rooster.pageSize}`);
check("page 4 (the fifth) is inside the budget", 4 < rooster.maxPages);
check("page 5 (a sixth) is refused by the adapter itself",
  (await rooster.fetchJobs({ keywords: ["intern"], page: rooster.maxPages })).length === 0,
  "returns [] without a request");

console.log("\n=== every source states how far the sweep may page it ===");

/* Read through getSource, not listSources: listSources returns a trimmed
   descriptor for the UI and drops maxPages, so asserting against that one
   would have been asserting against the wrong object. getSource returns
   what the sweep itself holds. */
for (const { id } of listSources()) {
  const src = getSource(id);
  const declared = typeof src.maxPages === "number";
  check(
    declared
      ? `${id.padEnd(8)} declares maxPages=${src.maxPages}`
      : `${id.padEnd(8)} pages internally, so the sweep's default of 4 applies`,
    typeof src.fetchJobs === "function" && (!declared || src.maxPages >= 1),
  );
}

/* The bug this replaced: one MAX_PAGES = 4 inside the sweep, applied to
   every adapter regardless of what the board actually holds. Rooster
   declares five pages of a hundred and lost its fifth to that constant. */
check("the sweep asks the adapter rather than assuming a number",
  readFileSync("src/services/poller/sweep.js", "utf8").includes("source.maxPages"));

console.log("\n=== Keells: the app's one definition of a word ===");

/* It used to lowercase and call String.includes(), so "intern" matched
   "international" and "internal audit". The rest of Job Wire has always
   used the word-boundary matcher; this is the source agreeing with it. */
const words = ["intern"];
all("a word is not matched inside a longer word", [
  "International Sales Executive",
  "Internal Audit Manager",
  "Internet Systems Engineer",
], (t) => !matchesAny(t, words));

all("but the word itself, in any position, is", [
  "Intern - Supply Chain",
  "Marketing Intern",
  "INTERN (Finance)",
  "Intern, Data",
], (t) => matchesAny(t, words));

check("keells imports the canonical matcher rather than its own",
  typeof keells.fetchJobs === "function");

console.log("\n=== an adapter reports what it DID, not just what it returned ===");

/* Health used to be one number: how many jobs the sweep ended up with.
   That number cannot tell a quiet board from a broken parser from one of
   LinkedIn's three surfaces going dark behind two that still work — all
   three read as "we saw fewer jobs", and only the first is fine. */
const { observer, normalize, checkPageShape, HEALTHY, DEGRADED } =
  await import("../src/services/sources/observe.js");

// A bare array is still valid, and is reported as inferred rather than
// claimed — seven adapters returned one yesterday, and rewriting all of
// them inside the change meant to make breakage visible would have been
// seven chances to break a working crawl.
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
const realPage = "<html><body><table>" + "<tr>row</tr>".repeat(20) + "</table>" + "x".repeat(600) + "</body></html>";
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


console.log("\n=== topjobs is a country corpus, not three hardcoded areas ===");

/* Measured 2026-09-10 with this adapter's own parser: 31 functional
   areas, 5,261 open vacancies, and the three areas the adapter crawled
   reached 336 of them — six per cent. A watch for an accounting
   internship had never had a single page of its own area fetched, and
   nothing anywhere would have said so. */
const Corpus = await import("../src/services/sources/topjobsCorpus.js");

check("every functional area the board publishes is listed",
  Corpus.AREAS.length === 31, `${Corpus.AREAS.length} areas`);
check("and the three that used to be the whole crawl are still among them",
  ["SDQ", "HNS", "COM"].every((fa) => Corpus.AREAS.some((a) => a.fa === fa)));

const openTotal = Corpus.AREAS.reduce((n, a) => n + a.open, 0);
const oldThree = Corpus.AREAS.filter((a) => ["SDQ", "HNS", "COM"].includes(a.fa))
  .reduce((n, a) => n + a.open, 0);
check("the old crawl reached a small fraction of the board",
  oldThree / openTotal < 0.1,
  `${oldThree} of ${openTotal} vacancies — ${Math.round((oldThree / openTotal) * 100)}%`);

Corpus.clearCorpus();

/* COLD START: everything is overdue, and the budget is what stops that
   becoming 31 requests at once. */
const firstDue = Corpus.dueAreas(Date.now());
check("a cold corpus does not fetch all 31 in one go",
  firstDue.length === Corpus.REFRESH_BUDGET,
  `${firstDue.length} areas, the budget`);

/* Lateness decides the ORDER; tiers decide how often. A cold area that
   has waited two hours goes before a hot one thirty seconds late. */
let fetched = [];
const fakeArea = (area) => { fetched.push(area.fa); return Promise.resolve([{ jobId: `tj-${area.fa}-1`, title: `${area.name} Intern` }]); };

await Corpus.refresh(fakeArea);
check("a pass fetches only its budget", fetched.length === Corpus.REFRESH_BUDGET, `${fetched.length}`);
const covered1 = Corpus.coverage();
check("and the corpus reports how much of the board it can see",
  covered1.areas === Corpus.REFRESH_BUDGET && covered1.share > 0 && covered1.share < 1,
  `${covered1.areas}/${covered1.ofAreas} areas, ${Math.round(covered1.share * 100)}% of vacancies`);

// Six passes later the whole board is covered.
for (let i = 0; i < 6; i++) { fetched = []; await Corpus.refresh(fakeArea); }
const full = Corpus.coverage();
check("a handful of passes reaches every area",
  full.areas === Corpus.AREAS.length,
  `${full.areas}/${full.ofAreas} — the old crawl could never reach more than 3`);
check("which is the whole board's vacancies, not six per cent",
  full.share === 1, `${Math.round(full.share * 100)}%`);
check("and the jobs are all there, de-duplicated",
  full.jobs === Corpus.AREAS.length, `${full.jobs} jobs`);

/* Nothing is due immediately after a refresh, so a pass that runs again
   straight away costs no requests at all. */
fetched = [];
await Corpus.refresh(fakeArea);
check("a freshly refreshed corpus asks for nothing", fetched.length === 0);

// Hot areas come round first once time passes.
const later = Date.now() + 11 * 60_000;
const hotDue = Corpus.dueAreas(later);
check("after eleven minutes the hot areas are due and the cold ones are not",
  hotDue.length > 0 && hotDue.every((a) => a.tier === "hot"),
  hotDue.map((a) => `${a.fa}(${a.tier})`).join(" "));

/* A FAILED REFRESH KEEPS WHAT IT HAD. "We could not look just now" and
   "this area has no vacancies" must not produce the same result — a
   transient 503 would otherwise read as a board that closed all 736 of
   its accounting vacancies at once. */
const before = Corpus.coverage().jobs;
const failing = () => Promise.reject(new Error("503 from the board"));
await Corpus.refresh(failing, { now: Date.now() + 2 * 60 * 60_000 });
const after = Corpus.coverage();
check("a failed refresh keeps the jobs it already had",
  after.jobs === before, `${before} -> ${after.jobs}`);
check("and says which areas are failing rather than reporting them empty",
  after.failing > 0, `${after.failing} failing`);

Corpus.clearCorpus();


console.log("\n=== the poller says ONE thing about itself ===");

/* A real screenshot of the admin page showed all of this at once:
 *
 *   top bar        Sweeping
 *   summary card   Stalled — no progress for 2 min
 *   detail row     state standby · queue 1 · last pass 77.3s
 *   badge          Not ticking
 *
 * Four labels, four definitions, one poller. These assert the states
 * that produced it. */
const RT = await import("../src/services/poller/runtime.js");
const { headerState } = await import("../src/utils/header.js");
const now = Date.parse("2026-09-11T10:00:00Z");
const ago = (ms) => new Date(now - ms);

/* STANDBY IS HEALTHY. Another process holds the lease and this one is
   correctly not crawling. It was being judged on a tick age it never
   updated, so it read as stale after ninety seconds. */
const standby = RT.pollerRuntime(
  { at: ago(3000), lastTickAt: ago(3000), state: "standby", queueDepth: 1, lastTickMs: 77300 },
  { owner: "other-host:41:ab", expiresAt: new Date(now + 240_000) },
  { enabled: true, now }
);
check("a standby poller is HEALTHY, not stalled", standby.status === RT.STANDBY && standby.healthy,
  `${standby.status}`);
check("and it says who is actually crawling", /other-host/.test(standby.detail), standby.detail);
check("the shell does NOT claim to be sweeping while on standby",
  headerState([{ active: true, q: {} }], standby).sweeping === false,
  "the chip read POLLER_ENABLED && activeWatches, which is configuration");

/* A LONG CRAWL IS NOT A STUCK ONE. A LinkedIn pass is 78-92 seconds
   measured, and the old threshold was 120. */
const longCrawl = RT.pollerRuntime(
  { at: ago(2000), lastTickAt: ago(150_000), state: "working",
    lastProgressAt: ago(4000), currentSource: "linkedin", currentSurface: "countryFeed", currentPage: 18 },
  null, { enabled: true, now }
);
check("a crawl running 150s but completing pages is WORKING",
  longCrawl.status === RT.WORKING && longCrawl.healthy, longCrawl.status);
check("and the detail says where it has got to",
  /linkedin/.test(longCrawl.detail) && /page 18/.test(longCrawl.detail), longCrawl.detail);
check("the shell agrees, because it reads the same snapshot",
  headerState([{ active: true, q: {} }], longCrawl).sweeping === true);

/* STALLED means an active operation stopped MOVING. */
const stuck = RT.pollerRuntime(
  { at: ago(2000), lastTickAt: ago(900_000), state: "working",
    lastProgressAt: ago(7 * 60_000), currentSource: "linkedin" },
  null, { enabled: true, now }
);
check("no page completing for seven minutes IS stalled",
  stuck.status === RT.STALLED && !stuck.healthy, stuck.status);
check("and it names the source it is stuck on", /linkedin/.test(stuck.detail), stuck.detail);

/* The worker itself going away is a different failure from the work
   stopping, and must not be reported as the same thing. */
const workerGone = RT.pollerRuntime(
  { at: ago(5 * 60_000), lastTickAt: ago(5 * 60_000), state: "working" },
  null, { enabled: true, now }
);
check("a heartbeat that stopped is OFFLINE, not merely stalled",
  workerGone.status === RT.OFFLINE, workerGone.status);

/* Configuration is not evidence, in either direction. */
const pollerOff = RT.pollerRuntime({ at: ago(1000), state: "idle" }, null, { enabled: false, now });
check("POLLER_ENABLED false reads as Off", pollerOff.status === RT.OFF);
check("and the shell does not claim to sweep with the poller off",
  headerState([{ active: true, q: {} }], pollerOff).sweeping === false);

const neverBeat = RT.pollerRuntime(null, null, { enabled: true, now });
check("no heartbeat at all is NEVER, not healthy", neverBeat.status === RT.NEVER && !neverBeat.healthy);
check("and an unreadable snapshot does not render as healthy either",
  headerState([{ active: true, q: {} }], null).sweeping === false,
  "claiming health we cannot observe is the whole family of bug this ends");

/* THE SCREENSHOT, ASSERTED. The exact state that produced four
   contradictory labels must now produce one. */
const chip = headerState([{ active: true, q: {} }], standby);
check("shell and admin now agree on the same state",
  chip.sweeping === false && standby.status === RT.STANDBY,
  `chip sweeping=${chip.sweeping}, runtime=${standby.status}`);
check("and the shell carries the snapshot's own label",
  chip.pollerLabel === "Standby", chip.pollerLabel);


console.log("\n=== the chip renders the state, not its own vocabulary ===");

/* CAUGHT BY A SCREENSHOT, TWICE, AND THE SECOND TIME WAS MY FIX BEING
   INCOMPLETE.
 *
 * Round one: topbar "Sweeping" / card "Stalled" / row "standby".
 * I replaced the model and updated headerState — and the TEMPLATE still
 * had its own ternary, which read:
 *
 *   sweeping ? 'Sweeping'
 *            : watchCount && !activeCount ? 'All held'
 *            : activeCount ? 'Poller off' : 'Idle'
 *
 * Once `sweeping` came to mean "this process is WORKING right now",
 * every other state — standby, idle, behind, offline — fell into the
 * "Poller off" branch, because that was the only word left. Round two:
 * topbar "Poller off" while the card said "Standby — another process is
 * crawling".
 *
 * Unit-testing headerState could not catch that, because headerState was
 * correct both times. So this renders the actual partial. */
const ejs = await import("ejs");
const { readFileSync: readChip } = await import("node:fs");
const chipTpl = readChip("src/views/partials/readouts.ejs", "utf8");

const renderChip = (locals) =>
  ejs.render(chipTpl, {
    oob: false, watchCount: 1, activeCount: 1, nextSweepAt: null, sweeping: false,
    ...locals,
  }, { filename: "src/views/partials/readouts.ejs" });

const standbyChip = renderChip({ pollerLabel: "Standby", pollerHealthy: true });
check("a standby poller does NOT render as 'Poller off'",
  !/Poller off/.test(standbyChip) && /Standby/.test(standbyChip),
  "that exact contradiction was on screen beside a card saying it was crawling");
check("and a healthy standby shows a live dot, not a dead one",
  /dot live/.test(standbyChip));

const workingChip = renderChip({ sweeping: true, pollerLabel: "Sweeping", pollerHealthy: true });
check("a working poller renders Sweeping", /Sweeping/.test(workingChip));

const offlineChip = renderChip({ pollerLabel: "Offline", pollerHealthy: false });
check("an offline poller says Offline, not 'Idle'",
  /Offline/.test(offlineChip) && !/Idle/.test(offlineChip));
check("and shows a dead dot", /dot off/.test(offlineChip));

const behindChip = renderChip({ pollerLabel: "Behind", pollerHealthy: true });
check("a poller that is behind schedule says so rather than 'Poller off'",
  /Behind/.test(behindChip) && !/Poller off/.test(behindChip));

/* The fallback must never be cheerful. A page that forgets the snapshot
   shows Unknown and a dark dot — claiming health nobody measured is the
   family of bug this model exists to end. */
const bareChip = renderChip({});
check("a page that forgets to pass the snapshot renders Unknown",
  /Unknown/.test(bareChip));
check("and does NOT show a live dot", !/dot live/.test(bareChip));

/* Every label runtime.js can produce must survive the template. A state
   the chip has no word for is how this broke both times. */
const RT2 = await import("../src/services/poller/runtime.js");
const everyState = [RT2.OFF, RT2.NEVER, RT2.OFFLINE, RT2.STANDBY,
                    RT2.WORKING, RT2.OVERDUE, RT2.STALLED, RT2.IDLE];
const rendered = everyState.map((st) => {
  const snap = RT2.pollerRuntime(
    { at: new Date(), lastTickAt: new Date(), state: "idle" }, null, { enabled: true });
  return renderChip({ pollerLabel: snap.label, pollerHealthy: snap.healthy });
});
check("every runtime state renders without throwing", rendered.length === everyState.length);
check("and none of them can produce the old guessed wording",
  rendered.every((h) => !/Poller off|All held/.test(h)),
  "the ternary is gone, so there is nothing left to guess with");


console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
