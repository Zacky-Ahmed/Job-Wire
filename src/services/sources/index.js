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
//   fetchJobs({ keywords, geoId, page })  ->  job[]
//                 One page. Return [] when there is nothing more.

import * as linkedin from "./linkedin.js";
import * as keells from "./keells.js";
import * as topjobs from "./topjobs.js";

export const SOURCES = { linkedin, keells, topjobs };

export const DEFAULT_SOURCE = "linkedin";

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
