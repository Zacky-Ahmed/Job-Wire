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

export const SOURCES = { linkedin, keells };

export const DEFAULT_SOURCE = "linkedin";

export function getSource(id) {
  return SOURCES[id] || null;
}

/** What the new-watch picker offers. */
export function listSources() {
  return Object.values(SOURCES).map((s) => ({
    id: s.id,
    label: s.label,
    perCountry: s.perCountry,
    note: s.note || "",
  }));
}

/** Prefix an id so two sites can never collide on the same number. */
export function qualify(sourceId, rawId) {
  return `${sourceId}:${rawId}`;
}
