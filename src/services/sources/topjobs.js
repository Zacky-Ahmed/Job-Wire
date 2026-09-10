// sources/topjobs.js
//
// topjobs.lk, Sri Lanka's largest job board. Unlike LinkedIn there is no
// search index sitting between the employer and us: a vacancy appears on
// the functional-area page the moment it is published.
//
// The board is organised by FUNCTIONAL AREA rather than by keyword, and
// each area is its own ~500KB page, so all thirty-one cannot be fetched
// every five minutes. This file used to name three of them and treat that
// as coverage; measured, it reached 336 of the board's 5,261 open
// vacancies — six per cent — and the other 4,925 did not exist as far as
// this system was concerned.
//
// The areas, their tiers and their refresh schedule now live in
// topjobsCorpus.js, which crawls them independently of any watch, a few
// of the most overdue per pass, and filters the corpus locally for
// whoever asked.
//
// Every listing is a table row shaped like this:
//
//   <td>3</td><td>1539252</td>
//   <td>
//     <span id="hdnJC2" hidden>0001539252</span>   job code
//     <span id="hdnEC2" hidden>DEFZZZ</span>       employer code
//     <span id="hdnAC2" hidden>DEFZZZ</span>       agency code
//     <h2><span>Graphic Designers</span></h2>
//     <h1>Company Name Withheld</h1>
//   </td>
//   <td>Please refer the vacancy</td>
//   <td>Thu Aug 20 2026</td>    opening date
//   <td>Thu Sep 03 2026</td>    closing date
//   <td>Colombo 10</td>
//
// The three hidden codes are what build a link to the advert, and the job
// code is stable, so it is the dedupe key.

import { guardedFetch } from "../http/guardedFetch.js";
import { observer, checkPageShape } from "./observe.js";
import * as Corpus from "./topjobsCorpus.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";
import * as cheerio from "cheerio";

export const id = "topjobs";
export const label = "topjobs.lk";
export const hosts = ["topjobs.lk"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka only
export const note = "Sri Lanka's biggest board — publishes instantly";
export const pageSize = 0; // one page per area; paging is internal
// Pages internally: fetchJobs returns everything on page 0 and [] after,
// so the sweep must ask exactly once. Declared rather than inferred, because
// the sweep previously applied one guessed cap to every source alike.
export const maxPages = 1;
// Listings carry an opening DATE and no time, so an age here cannot tell
// news from backlog. See the same note on keells.js.
export const timePrecision = "day";

const BASE = "https://www.topjobs.lk/applicant/vacancybyfunctionalarea.jsp";
const ADVERT = "https://www.topjobs.lk/employer/JobAdvertismentServlet";

// The area list, the tiers and the refresh schedule all live in
// topjobsCorpus.js now. Three hardcoded codes here reached 6% of the
// board; the measurement is in that file.

// The page is served as iso-8859-1. Decoding it as UTF-8 turns every
// en-dash into "?" — "Intern ? Human Resources Operations".
const CHARSET = "iso-8859-1";

const DATE_CELL = /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}$/;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/** "Thu Aug 20 2026" -> Date at midnight UTC. No time is published. */
function parseDate(text) {
  const d = new Date(`${text} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* Exported so the coverage probe counts with the SAME parser the sweep
   uses. A probe with its own selector measures its own selector: the
   first version of scripts/probe-topjobs-areas.js guessed one and
   reported zero vacancies in all thirty-one areas. */
export function parseArea(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  $("tr").each((_, tr) => {
    const $r = $(tr);
    const h2 = $r.find("h2").first();
    if (!h2.length) return; // header rows, layout rows

    const jc = clean($r.find("span[id^=hdnJC]").first().text());
    const ec = clean($r.find("span[id^=hdnEC]").first().text());
    const ac = clean($r.find("span[id^=hdnAC]").first().text());
    const title = clean(h2.text());
    if (!jc || !title) return; // markup we do not understand — skip, loudly upstream

    const cells = $r.find("td").map((_, td) => clean($(td).text())).get();
    const dates = cells.filter((c) => DATE_CELL.test(c));

    jobs.push({
      jobId: jc,
      title,
      company: clean($r.find("h1").first().text()) || "Unknown",
      location: cells[cells.length - 1] || "Sri Lanka",
      postedText: dates[0] || "",
      postedAt: dates[0] ? parseDate(dates[0]) : null,
      url: `${ADVERT}?rid=2&ac=${encodeURIComponent(ac)}&jc=${encodeURIComponent(jc)}&ec=${encodeURIComponent(ec)}`,
    });
  });

  return jobs;
}

/**
 * Sweeps every watched area and returns what matches.
 *
 * Filtering happens HERE rather than in a refine step, unlike LinkedIn:
 * the listing row already carries the title, and topjobs publishes no
 * employment-type field to check a job against. There is nothing a second
 * request would tell us.
 *
 * Paging is internal — one request per area — so page > 0 returns nothing.
 */
export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  const obs = observer(id);
  if (page > 0) return obs.done([]);

  /* THE BOARD IS A COUNTRY CORPUS, NOT A PER-WATCH SEARCH.

     Measured on 2026-09-10 with this file's own parser: topjobs has 31
     functional areas and 5,261 open vacancies. This adapter crawled
     three of them and reached 336 — SIX PER CENT. Accounting alone
     carries 736, more than twice the entire reach of the old crawl, and
     a watch for an accounting internship had never had a single page of
     its own area fetched. Nothing would have shown it: the adapter
     returned jobs, the counts looked normal, and the other 4,925
     vacancies simply did not exist as far as this system was concerned.

     Fetching all 31 per sweep is not the answer either — that is 31
     requests to one host on a five-minute clock, ten times the load on a
     board that has never once rate-limited us. So the areas are crawled
     independently of any watch, a few of the most overdue per pass, and
     the corpus is filtered locally for whoever asked. Every area is
     covered; none is covered every sweep; the per-pass cost is bounded
     by a budget rather than by how many areas exist. See
     topjobsCorpus.js for the tiers and why they are a proxy. */
  const results = await Corpus.refresh((area) => fetchArea(area));

  for (const r of results) {
    obs.surface(`area:${r.area.fa}`, {
      ok: r.ok, requests: 1, pages: 1,
      rawCount: r.rawCount ?? 0, parsedCount: r.jobs ?? 0,
      error: r.error || null,
    });
  }

  const cov = Corpus.coverage();
  /* Said on every observation, healthy or not, because partial coverage
     is a property of where the crawl has got to rather than a fault —
     and because a corpus that is 60% warm is a fact somebody reading the
     admin page needs, not an alarm. */
  obs.note(
    `corpus covers ${cov.areas}/${cov.ofAreas} areas, ` +
    `${Math.round(cov.share * 100)}% of the board's vacancies, ${cov.jobs} jobs held`
  );
  if (cov.failing) obs.warn(`${cov.failing} areas are failing to refresh`);

  const all = Corpus.all().map((j) => ({ ...j, jobId: qualify(id, j.jobId) }));

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  if (matchAll || !words.length) return obs.done(all);
  return obs.done(all.filter((j) => matchesAny(j.title, words)));
}

/**
 * One functional area, fetched and parsed.
 *
 * Throws on anything that is not the page we parse. The corpus keeps the
 * previous jobs for an area whose refresh failed, because "we could not
 * look just now" and "this area has no vacancies" must not produce the
 * same result — a transient 503 would otherwise read as a board that
 * closed all 736 of its accounting vacancies at once.
 */
async function fetchArea(area) {
  const html = await guardedFetch(
    `${BASE}?FA=${area.fa}&jst=OPEN`,
    hosts,
    { jitter: true, charset: CHARSET }
  );
  const parsed = parseArea(html);
  const shape = checkPageShape({
    html,
    containerFound: /<table/i.test(html),
    rowsFound: (html.match(/<tr/gi) || []).length,
    parsedCount: parsed.length,
  });
  if (!shape.ok) throw new Error(`${area.fa}: ${shape.error}`);
  return parsed;
}
