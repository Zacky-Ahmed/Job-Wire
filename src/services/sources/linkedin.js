// Bounded LinkedIn discovery. Search results are incomplete; rotate deeper
// pages across polls and share a durable HTTP budget with detail checks.

import { getDb } from "../../config/db.js";
import { guardedFetch } from "../http/guardedFetch.js";
import { parseJobs, parseCriteria, classifyResponse } from "../linkedin/parse.js";
import { findGeo } from "../linkedin/geoIds.js";
import { observer } from "./observe.js";
import * as CrawlLog from "../../models/crawlLog.js";
import { randomUUID } from "node:crypto";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";
import { log } from "../../utils/logger.js";

export const id = "linkedin";
export const label = "LinkedIn";
export const hosts = ["linkedin.com"];
export const perCountry = true;
export const note = "Limited public results; deeper pages rotate across checks";
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
/* Exported so the latency probe builds the SAME urls the sweep does.
   A probe with its own url is a probe measuring its own url — the
   topjobs coverage probe made exactly that mistake with a selector. */
export function pageUrlFor({ geoId, keywords, page }) {
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

export function urlFor({ geoId, keywords, page }) {
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

// Fetch at most two pages. The shared HTTP circuit can defer the second.
export async function fetchJobs({ keywords, geoId, page = 0, matchAll = false, trace = null }) {
  if (page > 0) return { jobs: [], observation: observer(id).done([]).observation };

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const query = words.join(" ");

  const obs = observer(id);

  const sweepId = trace?.sweepId || randomUUID().slice(0, 8);
  const walkStart = Date.now();

  /* Writing the walk down is diagnostics, and diagnostics may never
     break the crawl they describe. Failures here are swallowed inside
     CrawlLog.record. */
  const logWalk = (surface, startedAt, tally, { ok = true, error = null } = {}) =>
    CrawlLog.record({
      sweepId,
      queryId: trace?.queryId ?? null,
      source: id, surface, geoId,
      scheduledFor: trace?.scheduledFor ?? null,
      startedAt, finishedAt: Date.now(),
      pages: tally?.pageLog || [], stopReason: tally?.stopReason || "unknown",
      ok, error,
    });

  // One fresh page plus one rotating page, not three full crawls.
  // During recovery the HTTP circuit permits only one request per five minutes.
  const cursorStore = getDb().collection("linkedinSearchCursors");
  const cursorKey = JSON.stringify([geoId, query, matchAll]);
  const cursor = await cursorStore.findOne({ _id: cursorKey });
  const deepPage = cursor?.page || 1;
  const relevant = new Map(), everything = new Map();
  const targeted = !matchAll && !!query;
  const mainName = targeted ? "guestKeyword" : "countryFeed";
  const tasks = [
    { name: mainName, page: 0, url: urlFor({ geoId, keywords: targeted ? query : '', page: 0 }) },
    { name: mainName, page: deepPage, url: urlFor({ geoId, keywords: targeted ? query : '', page: deepPage }) },
  ];
  let firstError = null;
  for (const task of tasks) {
    const start = Date.now();
    try {
      const html = await guardedFetch(task.url, hosts, { jitter: true });
      const shape = classifyResponse(html);
      if (shape === 'unrecognised') throw new Error('LinkedIn returned unrecognised markup');
      const jobs = shape === 'empty' ? [] : parseJobs(html, new Date());
      const target = targeted ? relevant : everything;
      jobs.forEach(j => target.set(j.jobId, j));
      obs.surface(`${task.name}:${task.page}`, { ok: true, requests: 1, pages: 1, parsedCount: jobs.length });
      await logWalk(task.name, start, {pageLog:[{page:task.page,returned:jobs.length,jobIds:jobs.map(j=>j.jobId)}],stopReason:'budget'});
      if (task.page > 0) await cursorStore.updateOne({_id:cursorKey}, {$set:{page: jobs.length && deepPage < 39 ? deepPage + 1 : 1}}, {upsert:true});
    } catch (err) {
      firstError ||= err;
      obs.surface(`${task.name}:${task.page}`, { ok: false, requests: err.deferred && !err.status ? 0 : 1, pages: 0, error: err.message });
      await logWalk(task.name, start, {stopReason:'deferred'}, {ok:false,error:err.message});
      break;
    }
  }
  if (!relevant.size && !everything.size && firstError) throw firstError;
  obs.note('Bounded keyword discovery: deeper result pages rotate across polls; coverage is incomplete.');

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
      (relevant.has(j.jobId) ? "G" : ""),
  }));

  /* The country filter drops jobs, and that is not degradation — it is
     the filter working. Recorded so the gap between raw and parsed is
     explicable rather than alarming. */
  const droppedForCountry = merged.size - shaped.length;
  if (droppedForCountry) obs.raw(0);

  /* WHEN, not just whether. The surface mask says which surfaces saw a
     job; this says how far into the sweep we reached it. Measured, the
     country feed takes 67-75 seconds and matching jobs sit on its pages
     18-21, so a job can be a minute old before this process has looked
     at the page carrying it — and that minute is ours, not LinkedIn's. */
  const sweepMs = Date.now() - walkStart;
  for (const j of shaped) j._sweepMs = sweepMs;

  return obs.done(shaped);
}

const DETAIL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";

/* ONE FETCH OF A JOB'S PAGE PER SWEEP, NOT TWO.
 *
 * The same page answers two different questions and was being fetched
 * twice to answer them. refine() reads it for employment type and
 * seniority when a title does not match; the closure check reads it for
 * "no longer accepting applications" when a job is too old to mail. A
 * job that is BOTH — title did not match, and older than the cutoff —
 * hits both paths in one sweep and cost two requests to the same URL,
 * seconds apart, for one page.
 *
 * MEASURED FIRST, because the obvious bigger idea turned out to be
 * worth nothing: caching employment type globally by job id, across
 * searches, saves exactly the requests that two searches make for the
 * same job — and npm run probe-detail says that is currently ZERO of
 * 3,633 detail requests over a fortnight, because there is one LinkedIn
 * search. It will matter at N>1 and does not matter now; building it
 * today would be optimising a cost that does not exist. This one is
 * different: it is duplication WITHIN a single sweep and does not depend
 * on how many searches there are.
 *
 * THE TTL IS SHORT ON PURPOSE. Employment type and seniority are fixed
 * once a job is posted, but closure status is not — it is the entire
 * point of the closure check, and a stale "open" keeps telling people a
 * filled vacancy is worth applying to. Two minutes covers one sweep of
 * one query, which is all this is for. Anything longer would be caching
 * a fact that changes.
 */
const DETAIL_TTL_MS = 2 * 60_000;
const detailPages = new Map();   // rawId -> { html, at }

async function detailPage(rawId) {
  const hit = detailPages.get(rawId);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.html;

  const html = await guardedFetch(DETAIL + encodeURIComponent(rawId), hosts, { jitter: true });
  detailPages.set(rawId, { html, at: Date.now() });

  /* Bounded, because this is a process that runs for weeks. Evicting the
     oldest half rather than clearing outright so a sweep in progress does
     not lose the pages it just fetched. */
  if (detailPages.size > 2000) {
    const oldest = [...detailPages.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, 1000)) detailPages.delete(key);
  }
  return html;
}

/** For tests, and for anything that wants a guaranteed fresh read. */
export function clearDetailCache() {
  detailPages.clear();
}

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
  let deferRest = false;

  for (const job of jobs) {
    if (matchesAny(job.title, words)) {
      kept.push(strip({ ...job, matchedBy: "title", matchKind: "title" }));
      continue;
    }

    if (deferRest) {
      kept.push(strip({...job, matchedBy:"unverified", matchKind:"unverified", verificationDeferred:true}));
      continue;
    }
    let criteria = null;
    try {
      const raw = job.jobId.replace(/^linkedin:/, "");
      criteria = parseCriteria(await detailPage(raw));
    } catch (err) {
      deferRest = !!err.deferred;
      log.warn("could not read job criteria — returning it undecided", {
        jobId: job.jobId, message: err.message,
      });
      /* UNKNOWN, and unknown must never become yes.

         This job's title does NOT match — that was checked above — so
         the only thing that could justify emailing it is a tag we were
         unable to read. It is kept so a later sweep can try again, and
         matchKind is what stops anything downstream mistaking "we could
         not tell" for "it matches". */
      kept.push(strip({ ...job, matchedBy: "unverified", matchKind: "unverified", verificationDeferred: true }));
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
      /* A VERIFIED tag. matchedBy carries the tag's own value because
         that is the label the reader wants to see ("Internship"), not
         the name of the field it came from — but a display string is not
         something a safety guard can reason about, so matchKind states
         the kind separately. This is the one case where a job whose
         title does not match may legitimately be emailed. */
      kept.push(strip({ ...job, matchedBy: hit[1], matchKind: "tag", matchField: hit[0] }));
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
  /* matchKind survives the strip on purpose. _matchedByLinkedIn is
     internal bookkeeping; matchKind is the evidence the delivery guard
     is not allowed to proceed without. */
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
    /* The same page refine() may already have read this sweep. A job
       whose title did not match AND which is older than the cutoff hits
       both paths, and used to pay for the page twice. */
    const html = await detailPage(raw);
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
