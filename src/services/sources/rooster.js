// sources/rooster.js
//
// Rooster — a recruitment platform carrying Sri Lankan and regional jobs.
//
// The site is a Next.js app with nothing in its HTML; the listing comes
// from a JSON endpoint it POSTs to, which is what this uses. It is the
// only source here that needs a POST, and the only reason guardedFetch
// learned about request bodies.
//
// Two things learned by trying, both of which would fail silently:
//
//   · `query` must be an ARRAY. A string returns 400 "Query must be an
//     array" — loud, at least — but the shape is easy to get wrong.
//   · the country filter DOES NOT WORK. Passing country or countries is
//     accepted and then ignored: the same response comes back holding
//     Malaysia, Australia, Qatar and "Worldwide". Sri Lanka has to be
//     enforced here, exactly as linkedin.js had to start doing after
//     foreign jobs reached a Sri Lankan watch.

import { guardedFetch } from "../http/guardedFetch.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";

export const id = "rooster";
export const label = "Rooster";
export const hosts = ["api.rooster.jobs"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka
export const note = "Regional platform — JSON API, country filtered here";
export const pageSize = 100;
/* created_at carries a time ("2026-09-08 10:16:36") but no offset, and
   nothing in the response says which clock it is on. Sri Lanka is UTC+5:30,
   so reading a local stamp as UTC would make every job look five and a half
   hours OLDER than it is — and the age gate would then withhold genuinely
   fresh postings while looking exactly like a quiet day. That is the
   failure this project has walked into more than once, so the timestamp is
   recorded for display and arrival is what counts. */
export const timePrecision = "day";

const API = "https://api.rooster.jobs/jobSearch/jobs/search";
const MAX_PAGES = 5;

const inSriLanka = (loc) => /sri\s*lanka|colombo|kandy|galle|jaffna|negombo/i.test(String(loc || ""));

export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  if (page >= MAX_PAGES) return [];

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const body = await guardedFetch(API, hosts, {
    jitter: page === 0,
    accept: "application/json",
    method: "POST",
    // An empty query array is the whole listing, which is what a
    // match-all watch wants.
    body: JSON.stringify({
      query: matchAll ? [] : (words.length ? words : ["intern"]),
      limit: pageSize,
      page: page + 1,               // 1-based
    }),
  });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Rooster returned something that is not JSON");
  }

  const rows = payload?.body?.data;
  // A 200 whose body is not the expected shape means the contract moved.
  // Returning [] here would read as "no jobs today" for ever.
  if (!Array.isArray(rows)) {
    throw new Error("Rooster response had no body.data array — the API shape changed");
  }
  if (!rows.length) return [];

  const out = rows
    .filter((r) => r && r.id && r.title && inSriLanka(r.location))
    .map((r) => {
      const at = r.created_at ? new Date(String(r.created_at).replace(" ", "T") + "Z") : null;
      return {
        jobId: qualify(id, String(r.id)),
        title: String(r.title).trim().replace(/\s+/g, " "),
        company: String(r.company_name || r.subsidiary_company_name || "").trim() || "Rooster",
        location: String(r.location || "").trim(),
        url: `https://rooster.jobs/jobs/${r.id}`,
        postedText: r.created_at ? String(r.created_at) : "",
        postedAt: at && !Number.isNaN(at.getTime()) ? at : null,
      };
    });

  /* Their search reads the description as well as the title, so a query
     for "intern" comes back with roles that never say so. Same rule as
     everywhere else: the title is what this app matches on. */
  if (matchAll || !words.length) return out;
  return out.filter((j) => matchesAny(j.title, words));
}
