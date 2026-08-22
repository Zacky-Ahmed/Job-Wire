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

/**
 * Words that mean the same job to the person reading.
 *
 * Sri Lankan employers use "trainee" and "intern" interchangeably —
 * topjobs alone lists "Trainee Software Engineers", "Trainee QA Engineer"
 * and "Trainee IT" alongside roles titled "Intern", and they are the same
 * thing. Someone watching one and not being shown the other is missing
 * jobs for a vocabulary reason, not a relevance one.
 *
 * Kept deliberately small. Every entry here widens what arrives in
 * somebody's inbox, so a pair earns its place by being genuinely the same
 * role, not merely adjacent — "graduate" and "junior" are NOT here,
 * because plenty of those want experience an intern does not have.
 */
const SYNONYMS = {
  intern: ["trainee"],
  trainee: ["intern"],
  internship: ["trainee", "traineeship"],
  traineeship: ["intern", "internship"],
};

/** The word itself plus anything that means the same job. */
function expand(keywords) {
  const out = [];
  for (const w of keywords) {
    if (!w) continue;
    out.push(w);
    const also = SYNONYMS[String(w).trim().toLowerCase()];
    if (also) out.push(...also);
  }
  return [...new Set(out)];
}

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

/** True if any keyword, or a synonym of one, appears as a word. */
export function matchesAny(text, keywords) {
  if (!text) return false;
  return expand(keywords).some((w) => pattern(w).test(text));
}

/** Which word actually hit, or null. Useful for explaining a match. */
export function firstMatch(text, keywords) {
  if (!text) return null;
  return expand(keywords).find((w) => pattern(w).test(text)) || null;
}

/** What a keyword will really be searched for. For showing the reader. */
export function expandedFor(keywords) {
  return expand(Array.isArray(keywords) ? keywords : [keywords]);
}
