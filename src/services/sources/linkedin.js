// sources/linkedin.js
//
// MEASURED, not assumed. Every filter LinkedIn's guest endpoint offers
// drops jobs, and each one drops a DIFFERENT set. Same search, same
// moment, Sri Lanka, last 24h:
//
//   keywords=Intern    24 jobs   missing "Real Estate Sales Agent"
//   f_E=1              79 jobs   missing it too
//   f_JT=I             76 jobs   missing it too
//   no filter at all   73 jobs   HAS it
//
// That job is tagged Internship by the employer, which is why it shows
// in a logged-in search for "intern" — but its title says nothing about
// interning, so no keyword query finds it.
//
// The lesson from three rounds of this (f_TPR, sortBy, now keywords):
// LinkedIn's guest filters cannot be trusted to be complete, and the
// failure is always silent — indistinguishable from a quiet day.
//
// So we fetch BOTH and union them:
//   · the keyword query, because LinkedIn matches descriptions and job
//     type there, catching things a title never would
//   · the unfiltered country feed, because it is the only response that
//     is reliably complete
//
// then keep anything the keyword search returned, plus anything whose
// title matches. A watch can also ask for the country feed untouched,
// for people who would rather scan everything than miss anything.

import { guardedFetch } from "../http/guardedFetch.js";
import { parseJobs, parseCriteria, classifyResponse } from "../linkedin/parse.js";
import { findGeo } from "../linkedin/geoIds.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";
import { log } from "../../utils/logger.js";

export const id = "linkedin";
export const label = "LinkedIn";
export const hosts = ["linkedin.com"];
export const perCountry = true;
export const note = "Every employer, but minutes to an hour behind the posting";
export const pageSize = 10;
// Postings carry a relative age ("40 minutes ago"), so an age here is
// trustworthy to the minute and can be reasoned about.
export const timePrecision = "minute";

const ENDPOINT =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const WINDOW = 86400; // 24h. Narrower windows silently drop recent jobs.
// The Sri Lanka feed alone is 232 jobs deep. At 10 per page a cap of 10
// pages saw the first 100 and silently discarded the rest — and because
// sortBy is not honoured, "the rest" is not the oldest, it is a lottery.
// A Software Engineer Intern posted 40 minutes earlier sat on page 19.
// The break on an empty page is what actually ends the walk; this is only
// a runaway guard.
const MAX_PAGES = 40;
// Tolerate a repeated page rather than treating it as the end of the
// feed. Stopping at the first page that adds nothing new means one
// hiccup costs every job after it.
const STALE_PAGES_BEFORE_STOP = 2;

function urlFor({ geoId, keywords, page }) {
  const geo = findGeo(geoId);
  if (!geo) throw new Error(`Unknown geoId: ${geoId}`);
  const p = new URLSearchParams({
    location: geo.name,
    geoId: geo.geoId,
    f_TPR: "r" + WINDOW,
    start: String(page * pageSize),
  });
  if (keywords) p.set("keywords", keywords);
  return `${ENDPOINT}?${p}`;
}

/** Walk every page of one query until a page adds nothing new. */
async function collect(makeUrl) {
  const found = new Map();
  let stale = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await guardedFetch(makeUrl(page), hosts, { jitter: true });

    const shape = classifyResponse(html);
    if (shape === "empty") break;
    if (shape === "unrecognised") {
      const err = new Error("LinkedIn returned markup we do not recognise");
      err.code = "UNRECOGNISED";
      throw err;
    }

    // Resolve ages against the instant THIS page arrived, not against
    // whenever the sweep happens to finish.
    const jobs = parseJobs(html, new Date());
    if (!jobs.length) break;

    const before = found.size;
    jobs.forEach((j) => found.set(j.jobId, j));
    // sortBy is not honoured, so we cannot stop early on age — only when
    // the feed stops contributing, and only after it has done so twice.
    stale = found.size === before ? stale + 1 : 0;
    if (stale >= STALE_PAGES_BEFORE_STOP) break;
  }
  return found;
}

/**
 * Returns the widest honest view of the country's last 24h. Deliberately
 * does NOT filter: deciding whether a job matches needs its employment
 * type, which only the job's own page carries, and fetching that for all
 * ~70 jobs on every five-minute sweep would be absurd. `refine` below
 * makes that call for the handful that turn out to be new.
 *
 * Paging is internal — the two queries must be reconciled before anything
 * downstream sees them — so `page > 0` returns nothing.
 */
export async function fetchJobs({ keywords, geoId, page = 0, matchAll = false }) {
  if (page > 0) return [];

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const query = words.join(" ");

  // The complete feed, always.
  const everything = await collect((p) => urlFor({ geoId, page: p }));

  // LinkedIn's own matching, which sees descriptions and job type — the
  // only way to reach a job whose title never says "intern". Skipped
  // entirely when the watch already wants everything, since it could not
  // add anything the feed above does not already have.
  const relevant = query && !matchAll
    ? await collect((p) => urlFor({ geoId, keywords: query, page: p }))
    : new Map();

  const merged = new Map([...everything, ...relevant]);

  /* LinkedIn's own country filter leaks, and badly: a quarter of the
     matched jobs on a Sri Lanka watch were somewhere else entirely —
     Australia, the Philippines, and a long tail of American towns like
     Lander WY and Milton VT. Applying for those is not merely useless,
     it is the kind of noise that makes someone stop reading the emails.

     LinkedIn always names the country in a real location string
     ("Colombo, Western Province, Sri Lanka"), and the leaked ones never
     do ("Lander, WY"), so the country name is a reliable test HERE.
     It is not applied to the local boards: they print bare place names
     like "Colombo 3" and are single-country by declaration anyway. */
  const geo = findGeo(geoId);
  const country = (geo?.name || "").toLowerCase();
  const inCountry = (loc) => {
    if (!loc) return true;                    // never drop on missing data
    return !country || loc.toLowerCase().includes(country);
  };

  const shaped = [...merged.values()].filter((j) => inCountry(j.location)).map((j) => ({
    jobId: qualify(id, j.jobId),
    title: j.title,
    company: j.company,
    location: j.location || "",
    url: j.url,
    postedText: j.postedText || "",
    postedAt: j.postedAt, // resolved by parse.js against the fetch instant
    _matchedByLinkedIn: relevant.has(j.jobId),
  }));

  return shaped;
}

const DETAIL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";

/**
 * Decide which of these jobs the watch actually wants.
 *
 * Called with NEW jobs only, so the one-request-per-job cost lands on a
 * handful per sweep rather than the whole feed.
 *
 * A keyword is checked against the job's employment type and seniority as
 * well as its title, because that is what the reader means. Someone
 * watching "intern" wants the role tagged Internship whatever it calls
 * itself, and does not want a Full-time HVAC engineer that merely ranked
 * nearby in LinkedIn's relevance model. Title-only matching gets both of
 * those backwards.
 *
 * A job whose detail page could not be read comes back marked
 * "unverified". That is a question, not an answer: the caller decides
 * whether to retry it or give up and take it on trust. Treating it as a
 * match outright — which this used to do — emailed three jobs that were
 * plainly not internships, because a failed request is not evidence.
 */
export async function refine(jobs, { keywords, matchAll = false } = {}) {
  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  if (matchAll || !words.length) return jobs.map(strip);

  const kept = [];

  for (const job of jobs) {
    if (matchesAny(job.title, words)) {
      kept.push(strip({ ...job, matchedBy: "title" }));
      continue;
    }

    let criteria = null;
    try {
      const raw = job.jobId.replace(/^linkedin:/, "");
      const html = await guardedFetch(DETAIL + encodeURIComponent(raw), hosts, { jitter: true });
      criteria = parseCriteria(html);
    } catch (err) {
      log.warn("could not read job criteria — returning it undecided", {
        jobId: job.jobId, message: err.message,
      });
      kept.push(strip({ ...job, matchedBy: "unverified" }));
      continue;
    }

    // Test the same places LinkedIn's own search does, and remember WHICH
    // one hit — labelling every tag match with the employment type said
    // "Full-time" for a job whose SENIORITY was Internship, which reads
    // as a bug in the wire even though the job belonged there.
    /* The description is NOT consulted any more.
       It was added to match LinkedIn's own keyword search, and it does —
       including all the ways that search is wrong. It let in a Senior
       Google Ads Specialist, a Mechatronics Engineer, a Junior Estimator
       and an SEO Manager, none of which are internships: the body simply
       mentioned interns somewhere. Employment type and seniority are
       fields an employer deliberately set; prose is not a claim about
       what the job is. */
    const fields = [
      ["employment type", criteria.employmentType],
      ["seniority", criteria.seniority],
    ];
    const hit = fields.find(([, v]) => matchesAny(v, words));

    if (hit) {
      // The tag's own value is the label the reader wants to see
      // ("Internship"), not the name of the field it came from.
      kept.push(strip({ ...job, matchedBy: hit[1] }));
    } else {
      log.info("dropped a job LinkedIn's fuzzy search returned but the watch did not ask for", {
        jobId: job.jobId, title: job.title,
        employmentType: criteria.employmentType, seniority: criteria.seniority,
      });
    }
  }

  return kept;
}

function strip({ _matchedByLinkedIn, ...job }) {
  return job;
}
