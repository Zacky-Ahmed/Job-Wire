// sources/xpress.js
//
// XpressJobs — a large Sri Lankan job portal.
//
// The listing page is a React shell: the raw HTML is 2KB and contains no
// jobs at all. The data comes from a plain JSON endpoint the app calls
// itself, which is what this uses. That makes it one of the sturdier
// sources here — there is no markup to break on a redesign, only a
// response shape.
//
// Two things the endpoint insists on, both found by trying:
//   · postedIn is REQUIRED. Omit it and the API answers 400 with a
//     validation error, not an empty list.
//   · the response is a bare ARRAY, not an object with a data key. A
//     wrapper-shaped parse reads it as zero jobs and looks like a quiet
//     day, which is the failure mode this project keeps being bitten by.
//
// No posted time. createdDate comes back null on every record and the only
// date offered is expiryDateOnWebsite, so age cannot be judged here and
// arrival is the signal — same as topjobs and Keells.

import { guardedFetch } from "../http/guardedFetch.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";

export const id = "xpress";
export const label = "XpressJobs";
export const hosts = ["xpress.jobs"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka
export const note = "Sri Lankan portal — JSON API, no markup to break";
export const pageSize = 100;
// Externally paged, 100 a page, and the last-24-hours window holds a few
// hundred. Five is a runaway guard rather than a target.
export const maxPages = 5;
// createdDate is null on every record; there is no posting time to trust.
export const timePrecision = "day";

const API = "https://xpress.jobs/api/jobs/searchJobs";

/* Last 24 hours.
 *
 * A sweep runs every five minutes, so a day of history is already far
 * more than enough and keeps the response to a hundred rows. It is not a
 * freshness filter — dedupe decides what is new — it is a size limit. */
const POSTED_IN_24H = "1";

function urlFor(job) {
  const slug = String(job.jobTitle || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  return `https://xpress.jobs/jobs/view/${job.jobId}/${slug}`;
}

export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  const params = new URLSearchParams({
    page: String(page + 1),          // their paging is 1-based
    pageSize: String(pageSize),
    keyword: "",                     // matched here, not by them; see below
    locations: "",
    sectors: "",
    jobTypes: "",
    careerLevels: "",
    postedIn: POSTED_IN_24H,
    sortBy: "SortedCreateDate DESC",
    byCVLess: "false",
    byWalkIn: "false",
  });

  const body = await guardedFetch(`${API}?${params}`, hosts, {
    jitter: page === 0,
    accept: "application/json",
  });

  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("XpressJobs returned something that is not JSON");
  }
  // A 200 that is not an array means the contract moved. Say so rather
  // than returning [] and letting it read as a quiet day.
  if (!Array.isArray(rows)) {
    throw new Error("XpressJobs did not return an array — the API shape changed");
  }
  if (!rows.length) return [];

  const out = rows
    .filter((r) => r && r.jobId && r.jobTitle)
    .map((r) => ({
      jobId: qualify(id, String(r.jobId)),
      title: String(r.jobTitle).trim().replace(/\s+/g, " "),
      company: String(r.organizationName || "").trim() || "XpressJobs",
      // Their locations field arrives with a leading space, sometimes as
      // a comma-joined list of several.
      location: String(r.locations || "").trim().replace(/\s+/g, " "),
      url: urlFor(r),
      postedText: "",
      postedAt: null,
    }));

  /* Filtered on the title here rather than by passing their keyword
     parameter. Their search reads the description too, so "intern"
     returns Receptionist and Executive Chef — the same description-match
     noise that had to be stripped out of LinkedIn. The title is the only
     thing this app promises to match on. */
  if (matchAll) return out;
  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  if (!words.length) return out;
  return out.filter((j) => matchesAny(j.title, words));
}
