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
/* Exported, because the sweep caps paging too and used a single guessed
   number for every source. Its cap was 4 while this said 5, so the fifth
   page could never be requested and roughly a hundred of Rooster's ~490
   listings were unreachable. One number, declared where it is true. */
export const maxPages = 5;

/* Which listings belong to a Sri Lankan watch.

   Measured before it was changed, because the old rule — a regex of five
   city names OR "sri lanka" — looked arbitrary and turned out to be
   arbitrary in a specific way. Over 481 rows and 67 distinct location
   labels:

     407 rows were kept because the label literally contains "Sri Lanka"
       1 row  was kept by a city name, and that city was Colombo
      73 rows were dropped, every one of them genuinely foreign

   So the five cities were earning a single row between them. Rooster
   returns a Google-Places-style path ending in the country, which means
   the COUNTRY is the thing to test and a city list is a fallback for the
   rare bare label. The old rule was not losing Sri Lankan jobs — but
   only because none in that snapshot was posted as a bare city outside
   the five it happened to name. "Matara" alone would have been dropped
   in silence. The city list below is a real list rather than five
   examples, and it is only consulted when nothing names a country.

   REMOTE is a deliberate inclusion. 18 of those 73 dropped rows were
   "Anywhere, Worldwide" — remote roles a Sri Lankan can take, rejected
   only for not naming a country. They need no special rendering: the
   location string already reads "Anywhere, Worldwide", so the wire row
   and the email explain themselves. */
const SRI_LANKA = /\bsri\s*lanka\b/i;
const REMOTE = /\b(?:anywhere|worldwide|remote)\b/i;
const SL_PLACES =
  /\b(?:colombo|dehiwala|moratuwa|sri\s*jayaward[ea]nepura|kotte|negombo|gampaha|kalutara|kandy|matale|nuwara\s*eliya|galle|matara|hambantota|jaffna|kilinochchi|mannar|vavuniya|mullaitivu|batticaloa|ampara|trincomalee|kurunegala|puttalam|anuradhapura|polonnaruwa|badulla|monaragala|ratnapura|kegalle|panadura|katunayake|maharagama|kelaniya|ja-?ela|wattala|homagama|avissawella|chilaw|beruwala|weligama|bandarawela|hatton)\b/i;

export const inSriLanka = (loc) => {
  const s = String(loc || "").trim();
  if (!s) return false;                 // no location is not a Sri Lankan one
  if (SRI_LANKA.test(s)) return true;   // 407 of 408, in the measured snapshot
  if (REMOTE.test(s)) return true;      // open to anyone, so open to us
  /* Only for a label that names no country at all. "Colombo, Sri Lanka"
     is already caught above; "Colombo Street, Christchurch, New Zealand"
     must not be, and it carries a country to disqualify it with. */
  return !s.includes(",") && SL_PLACES.test(s);
};

export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  if (page >= maxPages) return [];

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
