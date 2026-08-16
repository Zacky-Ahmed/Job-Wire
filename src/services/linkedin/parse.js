// parse.js
//
// THE FRAGILE FILE. Everything else in this app is stable; this one
// breaks whenever LinkedIn changes their markup. Keep all selector
// knowledge here so a break is one file to fix.
//
// Two shapes are handled:
//   1. the guest endpoint /jobs-guest/jobs/api/seeMoreJobPostings/search
//      which returns a bare <li> list — no login, lightest option
//   2. the full /jobs/search page, as a fallback
//
// The job id is the only field that must be right: it is the dedupe key.
// urn:li:jobPosting:4012345678  ->  "4012345678"

import * as cheerio from "cheerio";

const ID_FROM_URN = /urn:li:jobPosting:(\d+)/;
const ID_FROM_URL = /\/jobs\/view\/(?:[^/]*-)?(\d+)/;

function extractId($card, href) {
  const urn = $card.attr("data-entity-urn") || $card.find("[data-entity-urn]").attr("data-entity-urn");
  const fromUrn = urn?.match(ID_FROM_URN)?.[1];
  if (fromUrn) return fromUrn;
  const id = $card.attr("data-id") || $card.find("[data-id]").attr("data-id");
  if (id && /^\d+$/.test(id)) return id;
  return href?.match(ID_FROM_URL)?.[1] ?? null;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/**
 * @returns {{jobId,title,company,location,url,postedText}[]}
 */
export function parseJobs(html, now = new Date()) {
  const $ = cheerio.load(html);
  const jobs = [];
  const seen = new Set();

  // Guest list items and search-page cards share enough structure that
  // one pass over both selectors covers them.
  const cards = $("li:has(a[href*='/jobs/view/']), div.base-card, div.job-search-card");

  cards.each((_, el) => {
    const $c = $(el);
    const $a = $c.find("a[href*='/jobs/view/']").first();
    const href = $a.attr("href");
    if (!href) return;

    const jobId = extractId($c, href);
    if (!jobId || seen.has(jobId)) return;

    const title = clean(
      $c.find(".base-search-card__title, .job-search-card__title, h3").first().text() || $a.text()
    );
    const company = clean(
      $c.find(".base-search-card__subtitle, .job-search-card__subtitle, h4").first().text()
    );
    const location = clean($c.find(".job-search-card__location, .base-search-card__metadata span").first().text());
    const postedText = clean($c.find("time, .job-search-card__listdate, .job-search-card__listdate--new").first().text());
    const datetime = $c.find("time").first().attr("datetime") || null;

    if (!title) return; // a card with no title is markup we do not understand

    seen.add(jobId);
    jobs.push({
      jobId,
      title,
      company: company || "Unknown",
      location,
      postedText,
      postedAt: resolvePostedAt(postedText, datetime, now),
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    });
  });

  return jobs;
}

/**
 * Read the criteria block off a single job posting page.
 *
 * This is the field the logged-in search actually filters on. A card in
 * the results list does not carry it, which is the whole reason Job Wire
 * kept disagreeing with what the user saw:
 *
 *   "Real Estate Sales Agent"  employment type Internship  -> belongs
 *   "Assistant Engineer HVAC"  employment type Full-time   -> does not
 *
 * Neither of those can be decided from the title, and the guest keyword
 * endpoint gets both of them wrong — it ranks by loose relevance, so it
 * drops the first and returns the second.
 */
export function parseCriteria(html) {
  const $ = cheerio.load(html);
  const out = {};
  $(".description__job-criteria-item, li.job-criteria__item").each((_, el) => {
    const key = clean($(el).find(".description__job-criteria-subheader, .job-criteria__subheader").text()).toLowerCase();
    const val = clean($(el).find(".description__job-criteria-text, .job-criteria__text").text());
    if (!key || !val) return;
    if (key.includes("employment")) out.employmentType = val;
    else if (key.includes("seniority")) out.seniority = val;
    else if (key.includes("function")) out.jobFunction = val;
  });
  return out;
}

const RELATIVE = /(\d+)\s*(minute|hour|day|week|month)/i;
const MS = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 };

/**
 * Turn a card's two conflicting age signals into one instant.
 *
 * LinkedIn gives us both, and each is precise where the other is not:
 *
 *   postedText  "1 hour ago"   minute-accurate, but relative to NOW
 *   datetime    "2026-08-16"   absolute, but DATE ONLY
 *
 * We used to take the datetime attribute whenever it existed. Because it
 * carries no time of day, `new Date("2026-08-16")` is midnight UTC — so a
 * job posted at 02:36 was recorded as having been posted at 00:00, and
 * every job caught during a morning looked hours older than it was. That
 * is what made the whole wire read "likely closed".
 *
 * So: for anything measured in minutes or hours, the relative text wins,
 * because at that scale it is the only signal with any resolution. Past a
 * day the relative text goes coarse ("2 weeks ago") and the exact date is
 * the better of the two.
 *
 * `now` must be the moment the page was FETCHED. Re-resolving stored text
 * against a later clock silently ages every job — a repair script once did
 * exactly that and made a week-old backlog look brand new.
 */
export function resolvePostedAt(postedText, datetime, now = new Date()) {
  const m = RELATIVE.exec(postedText || "");
  const exact = datetime ? new Date(datetime) : null;
  const exactOk = exact && !Number.isNaN(exact.getTime());

  if (m) {
    const unit = m[2].toLowerCase();
    const relative = new Date(now.getTime() - Number(m[1]) * MS[unit]);
    if (unit === "minute" || unit === "hour") return relative;
    return exactOk ? exact : relative;
  }
  return exactOk ? exact : null;
}

/**
 * Classify a response so a silent parser break is loud, WITHOUT crying
 * wolf on a legitimately empty result.
 *
 * LinkedIn answers "nothing matched your window" with a ~26 byte
 * document: "<!DOCTYPE html>\n\n<!---->". That is a normal, healthy
 * answer — at 3am there really are no new internships. Treating it as a
 * parser break would park every quiet query.
 *
 * The failure we DO need to catch is substantial HTML that contains no
 * job markup: a login wall, a captcha, or a markup change.
 *
 * @returns {"empty"|"jobs"|"unrecognised"}
 */
const EMPTY_MAX_BYTES = 400;

export function classifyResponse(html) {
  const body = (html || "").trim();
  if (/jobs\/view\/|jobPosting|job-search-card|base-card/.test(body)) return "jobs";
  // Tiny body with no <li> is LinkedIn's empty-result answer.
  if (body.length <= EMPTY_MAX_BYTES && !/<li[\s>]/i.test(body)) return "empty";
  return "unrecognised";
}
