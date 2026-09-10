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
//   · the unfiltered country feed, because it is the broadest single
//     response and the only one not shaped by a keyword filter we have
//     three times caught being silently incomplete
//
// It is NOT a superset, and calling it "reliably complete" — as this
// comment did — is the reason the union exists at all. Measured: the
// keyword surface returns jobs the country feed does not, which is
// exactly why dropping either one is a decision that has to be made
// against numbers rather than against a sentence in a comment.
//
// then keep anything the keyword search returned, plus anything whose
// title matches. A watch can also ask for the country feed untouched,
// for people who would rather scan everything than miss anything.

import { guardedFetch } from "../http/guardedFetch.js";
import { parseJobs, parseCriteria, classifyResponse } from "../linkedin/parse.js";
import { findGeo } from "../linkedin/geoIds.js";
import { observer } from "./observe.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";
import { log } from "../../utils/logger.js";

export const id = "linkedin";
export const label = "LinkedIn";
export const hosts = ["linkedin.com"];
export const perCountry = true;
export const note = "Every employer, but minutes to an hour behind the posting";
export const pageSize = 10;
// Pages internally: fetchJobs returns everything on page 0 and [] after,
// so the sweep must ask exactly once. Declared rather than inferred, because
// the sweep previously applied one guessed cap to every source alike.
export const maxPages = 1;
// Postings carry a relative age ("40 minutes ago"), so an age here is
// trustworthy to the minute and can be reasoned about.
export const timePrecision = "minute";

const ENDPOINT =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

/* The public search PAGE, which is a different surface from the guest
   API above and does not agree with it.
   
   Measured on one sweep, same keyword, same country, same minute:
   
     guest API  106 job ids
     this page   32 job ids
     in the page but NOT in the API: 25
   
   One of those 25 was an "Intern Software Engineer" posted an hour
   earlier — a plain title match that the API simply never returned, on
   any of its twelve pages. Two public endpoints, two different answers,
   and no way to tell from either one that the other has more.
   
   It emits the same base-search-card markup, so parse.js reads it
   unchanged. /jobs/search-results returns a shell with no cards and the
   lk. subdomain returns fewer than www., so the host and path here are
   both load-bearing. */
const PAGE = "https://www.linkedin.com/jobs/search";
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

function pageUrlFor({ geoId, keywords, page }) {
  const geo = findGeo(geoId);
  if (!geo) throw new Error(`Unknown geoId: ${geoId}`);
  const p = new URLSearchParams({
    location: geo.name,
    geoId: geo.geoId,
    f_TPR: "r" + WINDOW,
    start: String(page * pageSize),
  });
  if (keywords) p.set("keywords", keywords);
  return `${PAGE}?${p}`;
}

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
  if (page > 0) return { jobs: [], observation: observer(id).done([]).observation };

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const query = words.join(" ");

  /* THREE SURFACES, REPORTED SEPARATELY.

     They were unioned into one array and the sweep counted the result.
     That count cannot distinguish a quiet day from one of the three
     going dark: the country feed alone routinely carries most of the
     jobs, so the guest keyword API could stop answering entirely and the
     total would barely move. It is the single most likely way for this
     app to start missing jobs while every number on the admin page looks
     ordinary — which is the failure shape this whole project keeps
     having.

     So each one says what it did. A surface that fails makes the whole
     observation degraded; it does not fail the sweep, because two
     working surfaces are worth more than none. */
  const obs = observer(id);

  // The complete feed, always.
  const everything = await collect((p) => urlFor({ geoId, page: p }));
  obs.surface("countryFeed", {
    ok: true, requests: 1, pages: 1, rawCount: everything.size, parsedCount: everything.size,
  });

  // LinkedIn's own matching, which sees descriptions and job type — the
  // only way to reach a job whose title never says "intern". Skipped
  // entirely when the watch already wants everything, since it could not
  // add anything the feed above does not already have.
  let relevant = new Map();
  if (query && !matchAll) {
    try {
      relevant = await collect((p) => urlFor({ geoId, keywords: query, page: p }));
      obs.surface("guestKeyword", {
        ok: true, requests: 1, pages: 1, rawCount: relevant.size, parsedCount: relevant.size,
      });
    } catch (err) {
      /* Recorded, not thrown. This surface failing is exactly the case
         the union exists to survive — but it must not then look like a
         normal sweep, which is what happened before: the error went to a
         log line nobody reads and the jobs count stayed plausible. */
      obs.surface("guestKeyword", { ok: false, requests: 1, error: err.message });
      log.warn("linkedin guest keyword surface failed — continuing on the others", {
        message: err.message,
      });
    }
  } else {
    obs.surface("guestKeyword", { ok: true, requests: 0, parsedCount: 0, note: "not applicable to this watch" });
  }

  /* The third surface. Supplementary, so a failure here must not cost
     the sweep the other two — it is unioned in when it works and
     recorded as degraded when it does not. */
  let fromPage = new Map();
  if (!matchAll) {
    try {
      fromPage = await collect((p) => pageUrlFor({ geoId, keywords: query, page: p }));
      obs.surface("jserp", {
        ok: true, requests: 1, pages: 1, rawCount: fromPage.size, parsedCount: fromPage.size,
      });
    } catch (err) {
      obs.surface("jserp", { ok: false, requests: 1, error: err.message });
      log.warn("linkedin search page failed — continuing on the guest API alone", {
        message: err.message,
      });
    }
  } else {
    obs.surface("jserp", { ok: true, requests: 0, parsedCount: 0, note: "not applicable to a match-all watch" });
  }

  const merged = new Map([...everything, ...relevant, ...fromPage]);
  const onlyOnPage = [...fromPage.keys()].filter(
    (id) => !everything.has(id) && !relevant.has(id)
  ).length;
  if (onlyOnPage) {
    log.info("search page carried jobs the guest API did not return", {
      onlyOnPage, apiTotal: everything.size + relevant.size,
    });
  }

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
    _matchedByLinkedIn: relevant.has(j.jobId) || fromPage.has(j.jobId),
    /* WHICH SURFACES SAW THIS JOB.

       F = country feed, G = guest keyword, J = JSERP. Recorded on every
       job so the question "what does JSERP actually add?" can be
       answered with a measurement instead of a guess — the raw
       "1-8 extra jobs" figure counts jobs, and the number that decides
       whether to keep a surface is how many ACTIONABLE matches were
       visible only to it. Costs nothing to collect and cannot be
       reconstructed afterwards. */
    _surfaces:
      (everything.has(j.jobId) ? "F" : "") +
      (relevant.has(j.jobId) ? "G" : "") +
      (fromPage.has(j.jobId) ? "J" : ""),
  }));

  /* The country filter drops jobs, and that is not degradation — it is
     the filter working. Recorded so the gap between raw and parsed is
     explicable rather than alarming. */
  const droppedForCountry = merged.size - shaped.length;
  if (droppedForCountry) obs.raw(0);

  return obs.done(shaped);
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

/**
 * Is this posting still accepting applications?
 *
 * LinkedIn says so plainly on the job's own page:
 *
 *   <span class="closed-job closed-job__flavor …">
 *     No longer accepting applications
 *
 * Worth one request because the alternative is guessing from age, and
 * age is a bad proxy: LinkedIn's index runs a median of 27 minutes late
 * and a 90th percentile of two hours, so "old to us" and "closed" are
 * different facts. 604 live postings in one week were withheld from
 * email for being past a four hour clock, one of them by 60 seconds.
 *
 * Returns null when the answer is unknown — a failed request is not
 * evidence that a job is closed, and treating it as such would repeat
 * the matchedBy:"unverified" mistake in a new place.
 */
export async function isClosed(jobId) {
  const raw = String(jobId).replace(/^linkedin:/, "");
  try {
    const html = await guardedFetch(DETAIL + encodeURIComponent(raw), hosts, { jitter: true });
    if (/closed-job|no longer accepting applications/i.test(html)) return true;
    // A page that parsed but carries no marker is open.
    return /topcard|job-details|description__text/i.test(html) ? false : null;
  } catch (err) {
    log.warn("could not check whether a posting is closed", {
      jobId, message: err.message,
    });
    return null;
  }
}
