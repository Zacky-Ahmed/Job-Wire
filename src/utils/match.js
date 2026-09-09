// match.js
//
// Does this text contain this keyword the way a PERSON means it?
//
// Plain substring matching looked fine until we started reading job
// descriptions, and then "intern" quietly matched:
//
//   "our INTERNal processes"        Chief Human Resources Officer
//   "INTERNational clients"         Storage & Backup Administrator
//   "INTERNet security"             Senior Security Analyst
//
// Eighteen jobs in one sweep, none of them internships. But the naive fix
// — whole words only — is just as wrong in the other direction, because
// "internship" is a whole word that someone watching "intern" absolutely
// wants.
//
// So: match the keyword at a word boundary, optionally followed by one of
// the ordinary English endings, and require a boundary after that too.
// "intern" then reaches intern / interns / internship / internships /
// interning, and stops at internal / international / internet.

const SUFFIX = "(?:s|es|ship|ships|ing|ed|er|ers)?";

/* NO SYNONYMS.
 *
 * There were: intern and trainee were treated as the same word, on the
 * reasoning that Sri Lankan employers use them interchangeably and topjobs
 * lists "Trainee Software Engineer" beside roles titled "Intern".
 *
 * That is true of some of them and badly untrue of the rest. Watching
 * "intern" delivered Trainee Barista, Trainee Commi (Pastry & Bakery),
 * Trainee Bar Waiters, CCTV Installation Trainees, Trainee Metrologist and
 * Management Trainees — none of which is an internship, and all of which
 * arrived in an inbox alongside the ones that were.
 *
 * The keyword is now taken to mean the word. Somebody who wants trainee
 * roles can add "trainee" as a keyword and get exactly that, which is both
 * more honest and more controllable than a table deciding for them.
 */

const cache = new Map();

function pattern(word) {
  let re = cache.get(word);
  if (!re) {
    const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`\\b${escaped}${SUFFIX}\\b`, "i");
    cache.set(word, re);
  }
  return re;
}

/** True if any keyword appears as a word. */
export function matchesAny(text, keywords) {
  if (!text) return false;
  return keywords.filter(Boolean).some((w) => pattern(w).test(text));
}

/** Which word actually hit, or null. Useful for explaining a match. */
export function firstMatch(text, keywords) {
  if (!text) return null;
  return keywords.filter(Boolean).find((w) => pattern(w).test(text)) || null;
}

/** What a keyword will really be searched for. For showing the reader.
 *  Now simply the keywords themselves; kept so callers need not care. */
export function expandedFor(keywords) {
  return (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
}
