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
import { parseJobs, classifyResponse } from "../linkedin/parse.js";
import { findGeo } from "../linkedin/geoIds.js";
import { qualify } from "./index.js";

export const id = "linkedin";
export const label = "LinkedIn";
export const hosts = ["linkedin.com"];
export const perCountry = true;
export const note = "Every employer, but ~30 min behind the actual posting";
export const pageSize = 10;

const ENDPOINT =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const WINDOW = 86400; // 24h. Narrower windows silently drop recent jobs.
const MAX_PAGES = 10;

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
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await guardedFetch(makeUrl(page), hosts, { jitter: page === 0 });

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
    // a page stops contributing.
    if (found.size === before) break;
  }
  return found;
}

/**
 * Returns EVERY matching job for the watch in one call. Unlike a paged
 * source, the two queries have to be reconciled before filtering, so
 * paging is handled internally and `page > 0` returns nothing.
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

  const shaped = [...merged.values()].map((j) => ({
    jobId: qualify(id, j.jobId),
    title: j.title,
    company: j.company,
    location: j.location || "",
    url: j.url,
    postedText: j.postedText || "",
    postedAt: j.postedAt, // resolved by parse.js against the fetch instant
    _matchedByLinkedIn: relevant.has(j.jobId),
  }));

  if (matchAll || !words.length) return shaped.map(strip);

  const needles = words.map((w) => w.toLowerCase());
  return shaped
    .filter((j) => j._matchedByLinkedIn || needles.some((n) => j.title.toLowerCase().includes(n)))
    .map(strip);
}

function strip({ _matchedByLinkedIn, ...job }) {
  return job;
}
