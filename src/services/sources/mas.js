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

/* One vacancy, many requisitions.
 *
 * MAS raises a separate requisition per plant and per head, so a single
 * internship arrives as a run of consecutive ids: "Intern - Workforce
 * Management" came through as 21083, 21084, 21085, 21086, 21088, 21090
 * and 21110, all dated the same day, and each one produced its own email.
 * One morning's list held 7x Human Resources, 5x Merchandising, 5x
 * Industrial Engineering and 4x Planning the same way.
 *
 * They are not distinguishable. Checked against the API: secondaryLocations
 * is [] on every one, PrimaryLocation is the bare string "Sri Lanka", and
 * Organization is null — there is no field, expanded or otherwise, that
 * says which plant a requisition belongs to. So there is nothing to show a
 * reader that would make seven rows worth reading, and collapsing loses no
 * information the API ever gave us.
 *
 * The surviving id is derived from the group, NOT from a member. Keeping
 * the lowest member's id would look stable and quietly break: fill that
 * requisition and the id becomes the next one, which no sweep has ever
 * seen, and the whole group alerts a second time.
 *
 * PostedDate stays in the key so a fresh batch tomorrow is a fresh alert
 * rather than being swallowed by today's group.
 */
export function collapse(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const key = `${j.title.trim().toLowerCase()}::${j.postedText || "?"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }

  const out = [];
  for (const members of groups.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }
    // Lowest id first only so the link and the fields are taken from a
    // consistent member, not because the id itself is used.
    members.sort((a, b) =>
      Number(a.jobId.split(":")[1]) - Number(b.jobId.split(":")[1]));
    const slug = members[0].title.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    out.push({
      ...members[0],
      jobId: qualify(id, `g${members[0].postedText || "x"}-${slug}`),
      openings: members.length,
    });
  }
  return out;
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
  // Collapsed AFTER the country filter and BEFORE the keyword filter, so
  // a group is never split by a member that was filtered out from under it.
  const rolled = collapse(out);
  if (matchAll || !words.length) return rolled;
  return rolled.filter((j) => matchesAny(j.title, words));
}
