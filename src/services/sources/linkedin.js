// sources/linkedin.js
//
// The broadest source: every employer, but with a real cost — LinkedIn
// takes tens of minutes to put a new posting into its SEARCH index, and
// nothing can poll past that. A company's own careers site publishes
// immediately, which is why the other adapters exist.
//
// Parsing lives in linkedin/parse.js, which is the fragile file: when
// LinkedIn changes markup, that is the only thing that breaks.

import { guardedFetch } from "../http/guardedFetch.js";
import { buildGuestUrl } from "../linkedin/buildUrl.js";
import { parseJobs, classifyResponse } from "../linkedin/parse.js";
import { qualify } from "./index.js";

export const id = "linkedin";
export const label = "LinkedIn";
export const hosts = ["linkedin.com"];
export const perCountry = true;
export const note = "Every employer, but ~30 min behind the actual posting";
export const pageSize = 10;

/** One page of results, already in the shared shape. */
export async function fetchJobs({ keywords, geoId, page = 0 }) {
  const url = buildGuestUrl({
    keywords,
    geoId,
    sweepMinutes: 5, // unused now — the window is pinned inside buildUrl
    start: page * pageSize,
  });

  const html = await guardedFetch(url, hosts, { jitter: page === 0 });

  const shape = classifyResponse(html);
  if (shape === "empty") return [];
  if (shape === "unrecognised") {
    const err = new Error("LinkedIn returned markup we do not recognise");
    err.code = "UNRECOGNISED";
    throw err;
  }

  const now = new Date();
  return parseJobs(html).map((j) => ({
    jobId: qualify(id, j.jobId),
    title: j.title,
    company: j.company,
    location: j.location || "",
    url: j.url,
    postedText: j.postedText || "",
    postedAt: j.postedAt || relativeToDate(j.postedText, now),
  }));
}

/** "30 minutes ago" read at a known instant -> an absolute Date. */
function relativeToDate(text, at) {
  const m = /(\d+)\s*(minute|hour|day|week)/i.exec(text || "");
  if (!m) return null;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[m[2].toLowerCase()];
  return new Date(at.getTime() - Number(m[1]) * unit);
}
