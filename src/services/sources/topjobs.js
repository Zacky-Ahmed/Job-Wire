// sources/topjobs.js
//
// topjobs.lk, Sri Lanka's largest job board. Unlike LinkedIn there is no
// search index sitting between the employer and us: a vacancy appears on
// the functional-area page the moment it is published.
//
// The board is organised by FUNCTIONAL AREA rather than by keyword, and
// each area is its own ~500KB page, so we cannot fetch all thirty-one of
// them every five minutes. AREAS below is the set we watch. Adding one is
// a single line; the full list of codes is in the site's own nav.
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
// Listings carry an opening DATE and no time, so an age here cannot tell
// news from backlog. See the same note on keells.js.
export const timePrecision = "day";

const BASE = "https://www.topjobs.lk/applicant/vacancybyfunctionalarea.jsp";
const ADVERT = "https://www.topjobs.lk/employer/JobAdvertismentServlet";

// The areas we sweep. Codes are topjobs' own.
const AREAS = [
  { fa: "SDQ", name: "IT-Software/DB/QA/Web/Graphics" },
  { fa: "HNS", name: "IT-Hardware/Networks/Systems" },
  { fa: "COM", name: "Corporate Management/Analysts" },
];

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

function parseArea(html) {
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
  if (page > 0) return [];

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const found = new Map();
  const failures = [];

  for (const area of AREAS) {
    try {
      const html = await guardedFetch(
        `${BASE}?FA=${area.fa}&jst=OPEN`,
        hosts,
        { jitter: true, charset: CHARSET }
      );
      for (const job of parseArea(html)) {
        // A vacancy can be listed under more than one area; the job code
        // is the same, so the Map collapses it rather than alerting twice.
        if (!found.has(job.jobId)) found.set(job.jobId, { ...job, area: area.name });
      }
    } catch (err) {
      failures.push(`${area.fa}: ${err.message}`);
    }
  }

  // One area being down should not look like a quiet day, but it should
  // not lose the other two either.
  if (failures.length === AREAS.length) {
    throw new Error(`every topjobs area failed — ${failures.join("; ")}`);
  }

  const all = [...found.values()].map((j) => ({
    ...j,
    jobId: qualify(id, j.jobId),
  }));

  if (matchAll || !words.length) return all;
  return all.filter((j) => matchesAny(j.title, words));
}
