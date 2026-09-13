// sources/index.js
//
// The registry of places we look for jobs.
//
// Everything downstream of a source — dedupe, seenJobs, the email
// batching, the retry queue — only ever sees the shared job shape below,
// so adding a site means adding a sibling adapter and nothing else.
//
// THE SHARED JOB SHAPE
//   {
//     jobId:      "linkedin:4453290868"   source-prefixed, globally unique
//     title:      "Software Engineering Intern"
//     company:    "Sysco LABS"
//     location:   "Colombo, LK"            may be ""
//     url:        "https://…"              where to apply
//     postedAt:   Date | null              absolute, resolved at capture
//     postedText: "30 minutes ago"         what the site said, for display
//   }
//
// THE ADAPTER CONTRACT
//   id            short slug, used as the jobId prefix
//   label         what a user sees in the picker
//   hosts         allowlist for guardedFetch — never widen casually
//   perCountry    true if the source is country-scoped (LinkedIn), false
//                 if it is one employer's own site (Keells)
//   fetchJobs({ keywords, geoId, page, matchAll })  ->  job[]
//                 One page. Return [] when there is nothing more.
//   maxPages      how many times the sweep may call fetchJobs with an
//                 increasing page. 1 means the adapter pages internally and
//                 returns everything on page 0. The sweep used to apply one
//                 guessed cap to every source, which starved Rooster of its
//                 fifth page and wasted three calls on every internal pager.
//   timePrecision "minute" if the site publishes a real time, "day" if it
//                 prints only a date — a date resolves to midnight, so a
//                 job posted this morning already reads as hours old and
//                 its age cannot be used to decide whether it is news.
//                 Day-precision sources skip the age gate entirely.
//   refine        optional. A second pass that may spend one request per
//                 job to read what a results page does not carry.
//   isClosed      optional. Answers "is this posting still open?" so an
//                 older job can be checked rather than assumed dead.
//
// A source that cannot decide must THROW, never return []. An empty array
// means "nothing today", and every silent failure this project has had
// looked exactly like a quiet day.

import * as linkedin from "./linkedin.js";
import * as keells from "./keells.js";
import * as topjobs from "./topjobs.js";
import * as mas from "./mas.js";
import * as itpro from "./itpro.js";
import * as xpress from "./xpress.js";
import * as rooster from "./rooster.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

const ALL_SOURCES = { linkedin, keells, topjobs, mas, itpro, xpress, rooster };

/**
 * The adapters this deployment may actually use.
 *
 * REMOVED, not skipped. A disabled source is absent from the
 * registry, so getSource returns null, sourcesForCountry never names
 * it, the watch form never offers it, and a query row that still
 * lists it sweeps everything else and quietly leaves it alone. There
 * is no code path that can reach an adapter that is not here.
 *
 * That distinction matters when the reason for disabling is a host
 * saying "not on our infrastructure": a flag checked in one place is
 * a flag somebody forgets in another.
 *
 * LinkedIn is additionally removed unless LINKEDIN_ACCESS_CONFIRMED=true.
 * Even if it is not in SOURCES_DISABLED, the adapter will not appear in
 * the registry without an explicit operator attestation of written
 * authorization. This is a second, independent gate so that a deployment
 * mistake (forgetting to add linkedin to SOURCES_DISABLED) cannot silently
 * re-enable the source.
 */
export const SOURCES = Object.fromEntries(
  Object.entries(ALL_SOURCES).filter(([id]) => {
    if (env.disabledSources.includes(id)) return false;
    if (id === "linkedin" && !env.linkedinAccessConfirmed) return false;
    return true;
  })
);

export const DISABLED_SOURCES = Object.keys(ALL_SOURCES)
  .filter((id) => !SOURCES[id]);

if (env.disabledSources.length || !env.linkedinAccessConfirmed) {
  log.warn("sources disabled for this deployment", {
    byConfig: env.disabledSources.join(",") || "(none)",
    linkedinGate: env.linkedinAccessConfirmed
      ? "confirmed"
      : "excluded — LINKEDIN_ACCESS_CONFIRMED is not set",
    active: Object.keys(SOURCES).join(",") || "(none)",
  });
}

/* The fallback when a query names nothing usable. Falls through to
   whatever IS enabled, so a LinkedIn-less deployment still has a
   sensible default rather than a dangling id. */
export const DEFAULT_SOURCE = SOURCES.linkedin ? "linkedin" : Object.keys(SOURCES)[0] || null;

export function getSource(id) {
  return SOURCES[id] || null;
}

/**
 * What the new-watch picker offers.
 *
 * `countries` matters to the UI: a source that only covers Sri Lanka has
 * no business appearing when someone picks Germany. An empty list means
 * the source is country-agnostic and always applicable.
 */
export function listSources() {
  return Object.values(SOURCES).map((s) => ({
    id: s.id,
    label: s.label,
    perCountry: s.perCountry,
    countries: s.countries || [],
    note: s.note || "",
  }));
}

/**
 * Every source that can serve this country.
 *
 * Which sites to search was once a row of checkboxes, which asked the
 * reader to make a decision they had no basis for: nobody wants FEWER
 * places searched for the same keyword. Watching Sri Lanka means watching
 * everything that covers Sri Lanka.
 *
 * Resolved at sweep time rather than frozen into the query row, so
 * adding an adapter reaches every existing watch instead of only new
 * ones.
 */
export function sourcesForCountry(geoId) {
  return Object.values(SOURCES)
    .filter((s) => !s.countries?.length || s.countries.includes(String(geoId)))
    .map((s) => s.id);
}

/** Is this source usable for that country? */
export function sourceCoversCountry(sourceId, geoId) {
  const s = SOURCES[sourceId];
  if (!s) return false;
  if (!s.countries || !s.countries.length) return true; // global
  return s.countries.includes(String(geoId));
}

/** Prefix an id so two sites can never collide on the same number. */
export function qualify(sourceId, rawId) {
  return `${sourceId}:${rawId}`;
}
