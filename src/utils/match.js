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

/** True if any keyword appears in the text as a word, not as a fragment. */
export function matchesAny(text, keywords) {
  if (!text) return false;
  return keywords.some((w) => w && pattern(w).test(text));
}

/** Which keyword hit, or null. Useful for explaining a match to the user. */
export function firstMatch(text, keywords) {
  if (!text) return null;
  return keywords.find((w) => w && pattern(w).test(text)) || null;
}
