// probe-topjobs-areas.js
//
//   npm run probe-topjobs
//
// Which functional areas topjobs actually has, and how many open
// vacancies each one carries. Read-only: no database, no mail, nothing
// written anywhere.
//
// This exists because the adapter crawls three areas — IT-Software,
// IT-Hardware and Corporate Management — and the comment beside them
// says the board has roughly 31. If that is right, a watch for an
// accounting, HR, hospitality or engineering internship believes it has
// topjobs coverage and has never had a single page of it fetched. That
// is a bigger hole than any parser bug, and it is not a hole anybody can
// see from the outside.
//
// Before deciding how to close it, measure. Crawling all 31 areas on
// every sweep is not obviously right either — it is 31 requests to one
// host on a five-minute clock — and the sensible answer probably depends
// on how the vacancies are distributed. So: list the areas, count them,
// and see.

import { guardedFetch } from "../src/services/http/guardedFetch.js";
import { parseArea } from "../src/services/sources/topjobs.js";
import * as cheerio from "cheerio";

const HOSTS = ["topjobs.lk"];
const LIST = "https://www.topjobs.lk/applicant/vacancybyfunctionalarea.jsp";
const CHARSET = "iso-8859-1";
const CRAWLED = ["SDQ", "HNS", "COM"];      // what the adapter asks for today

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/* The area list is on the page itself: topjobs renders every functional
   area as a link carrying its own FA code. Read from the live page
   rather than hardcoded, because a hardcoded list is exactly the kind of
   thing that silently goes stale — which is how three areas came to be
   described as "roughly 31" with no way to check. */
const html = await guardedFetch(`${LIST}?FA=SDQ&jst=OPEN`, HOSTS, { jitter: false, charset: CHARSET });
const $ = cheerio.load(html);

const areas = new Map();
$("a[href*='FA=']").each((_, el) => {
  const href = $(el).attr("href") || "";
  const m = href.match(/FA=([A-Z0-9]+)/);
  if (!m) return;
  const name = clean($(el).text());
  if (!name) return;
  if (!areas.has(m[1])) areas.set(m[1], name);
});

if (!areas.size) {
  console.error(
    "no functional-area links found on the page.\n" +
    "Either the markup changed or this URL no longer lists them — do not\n" +
    "assume the board has three areas because this found none."
  );
  process.exit(1);
}

console.log(`topjobs lists ${areas.size} functional areas\n`);

const counts = [];
for (const [fa, name] of areas) {
  try {
    const page = await guardedFetch(`${LIST}?FA=${fa}&jst=OPEN`, HOSTS, { jitter: true, charset: CHARSET });
    const $ = cheerio.load(page);
    /* Counted by the ADAPTER'S OWN parser, not by a selector invented
       here.

       The first version of this probe guessed at a link selector and
       reported zero vacancies in all thirty-one areas — which is
       precisely the failure this whole phase is about, produced by the
       probe written to investigate it. A count that disagrees with what
       the adapter sees is not a measurement of anything.

       The raw row count is kept beside it so the two can be compared: if
       the page has rows and the parser finds none, that is drift, not an
       empty board. */
    const rawRows = $("tr").length;
    const parsed = parseArea(page).length;
    counts.push({ fa, name, rows: parsed, rawRows, crawled: CRAWLED.includes(fa) });
  } catch (err) {
    counts.push({ fa, name, rows: null, crawled: CRAWLED.includes(fa), error: err.message });
  }
}

counts.sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1));

const total = counts.reduce((n, c) => n + (c.rows || 0), 0);
const covered = counts.filter((c) => c.crawled).reduce((n, c) => n + (c.rows || 0), 0);

console.log("  jobs   rows  crawled  code  area");
for (const c of counts) {
  console.log(
    `  ${String(c.rows ?? "err").padStart(4)}  ${String(c.rawRows ?? "-").padStart(5)}  ` +
    `${c.crawled ? "   yes " : "    no "}  ${c.fa.padEnd(5)} ${c.name}` +
    (c.error ? `  (${c.error})` : "")
  );
}

/* The invariant, applied to the probe itself. A page full of table rows
   that parses to nothing is drift, and saying "0 vacancies" about it
   would be repeating the mistake. */
const suspicious = counts.filter((c) => (c.rawRows || 0) > 20 && c.rows === 0);
if (suspicious.length) {
  console.log(
    `\nWARNING: ${suspicious.length} areas had rows on the page and parsed to zero.\n` +
    `That is parser drift, not an empty board — do not read the counts above as coverage.`
  );
}

console.log(`\ntotal open vacancies across all areas: ${total}`);
console.log(`reachable by the three areas crawled:   ${covered}  (${Math.round((covered / total) * 100)}%)`);
console.log(`invisible to every watch:               ${total - covered}`);

/* The distribution is the thing that decides the design. If a handful of
   areas carry most of the board, tiered cadences are worth the
   complexity; if it is flat, they are not and the honest answer is to
   crawl the lot on a slower clock. */
const sorted = counts.map((c) => c.rows || 0).sort((a, b) => b - a);
const topFive = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
console.log(`\nthe five largest areas carry ${topFive} of ${total} (${Math.round((topFive / total) * 100)}%)`);
console.log(`areas with no open vacancies at all: ${sorted.filter((n) => n === 0).length}`);
