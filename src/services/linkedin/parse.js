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
export function parseJobs(html) {
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
      postedAt: datetime ? new Date(datetime) : null,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    });
  });

  return jobs;
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
