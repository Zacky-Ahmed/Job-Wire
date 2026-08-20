// sources/mas.js
//
// MAS Holdings, on Oracle Cloud Recruiting (the "Candidate Experience"
// product). Sri Lanka's largest apparel manufacturer, and one of the
// bigger intern employers in the country.
//
// Unlike every other source here this one is a proper JSON API rather
// than scraped markup, so it cannot break on a CSS change. What it CAN
// break on is Oracle's finder syntax, which is fussy and undocumented:
//
//   · `facetsList` is not optional. Drop it and the response is a 200
//     with no requisitionList at all — success-shaped and empty, the
//     exact failure mode this project keeps getting bitten by.
//   · `expand=requisitionList.secondaryLocations` is what actually
//     populates the list. Without it you get the same silent nothing.
//
// So the response is checked for the LIST, not for a status code.
//
// The site is one employer, so there is no per-job company field —
// every requisition is MAS.

import { guardedFetch } from "../http/guardedFetch.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";

export const id = "mas";
export const label = "MAS Holdings";
// The exact tenant, not "oraclecloud.com". The allowlist matches
// subdomains, so the broader form would authorise every Oracle Cloud
// customer on the internet — far more than this adapter needs.
export const hosts = ["egmh.fa.us6.oraclecloud.com"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka
export const note = "Apparel group — posts to its own portal instantly";
export const pageSize = 0; // paging is internal
// PostedDate is "2026-08-20" — a date, no time. Same reasoning as
// keells.js and topjobs.js: arrival is the signal, not printed age.
export const timePrecision = "day";

const HOST = "https://egmh.fa.us6.oraclecloud.com";
const API = `${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
const SITE = "CX_1";
const PAGE = 200;
const MAX_PAGES = 10; // 2000 requisitions; runaway guard, not a limit

function urlFor(offset) {
  // Deliberately assembled by hand rather than with URLSearchParams: the
  // finder is one value containing ";" and "," separators that Oracle
  // parses itself, and percent-encoding them breaks it.
  const finder =
    `findReqs;siteNumber=${SITE},` +
    `facetsList=LOCATIONS;WORK_LOCATIONS;TITLES;CATEGORIES;POSTING_DATES,` +
    `limit=${PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;
  return `${API}?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`;
}

function shape(r) {
  const posted = r.PostedDate ? new Date(`${r.PostedDate}T00:00:00Z`) : null;
  return {
    jobId: qualify(id, String(r.Id)),
    title: (r.Title || "").trim(),
    company: label,
    location: r.PrimaryLocation || "Sri Lanka",
    url: `${HOST}/hcmUI/CandidateExperience/en/sites/${SITE}/job/${r.Id}`,
    postedText: r.PostedDate || "",
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : null,
    _country: r.PrimaryLocationCountry || "",
  };
}

export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  if (page > 0) return [];

  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const found = new Map();
  let total = null;

  for (let p = 0; p < MAX_PAGES; p++) {
    const body = await guardedFetch(urlFor(p * PAGE), hosts, {
      jitter: true,
      accept: "application/json",
    });

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("MAS returned something that is not JSON");
    }

    const bucket = data.items?.[0];
    const list = bucket?.requisitionList;

    // A 200 carrying no list means the finder was rejected, not that the
    // employer has no vacancies. Saying so out loud is the whole point —
    // an empty array here would look exactly like a quiet week.
    if (!Array.isArray(list)) {
      throw new Error("MAS returned no requisitionList — the finder syntax was rejected");
    }
    if (total === null) total = bucket.TotalJobsCount ?? null;
    if (!list.length) break;

    const before = found.size;
    list.forEach((r) => found.set(String(r.Id), shape(r)));
    if (found.size === before) break;
    if (total !== null && found.size >= total) break;
  }

  // The portal serves more than one country; a Sri Lanka watch should not
  // be offered a vacancy in Jordan or Indonesia.
  const inCountry = [...found.values()].filter(
    (j) => !j._country || j._country === "LK"
  );

  const out = inCountry.map(({ _country, ...job }) => job);
  if (matchAll || !words.length) return out;
  return out.filter((j) => matchesAny(j.title, words));
}
