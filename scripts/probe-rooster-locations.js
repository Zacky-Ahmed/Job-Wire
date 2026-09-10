// probe-rooster-locations.js
//
//   npm run probe-rooster
//
// What Rooster actually puts in `location`, and what the country gate
// keeps and drops. Read-only: no database, no mail, no writes anywhere.
//
// This exists because the gate it checks was originally a regex of five
// city names, and nobody could say whether those five were the right
// five or whether real Sri Lankan jobs were being thrown away by them.
// The answer turned out to be measurable in one run — the five cities
// were earning a single row out of 481 — and the same question will come
// back the next time somebody reads that list and wonders. Run this
// rather than guess.

import { guardedFetch } from "../src/services/http/guardedFetch.js";
import * as rooster from "../src/services/sources/rooster.js";

const API = "https://api.rooster.jobs/jobSearch/jobs/search";

const seen = new Map();
let rows = 0;

for (let page = 0; page < rooster.maxPages; page++) {
  const body = await guardedFetch(API, rooster.hosts, {
    jitter: false,
    accept: "application/json",
    method: "POST",
    // An empty query array is the whole board, which is the point here.
    body: JSON.stringify({ query: [], limit: rooster.pageSize, page: page + 1 }),
  });
  const list = JSON.parse(body)?.body?.data;
  if (!Array.isArray(list) || !list.length) break;
  rows += list.length;
  for (const r of list) {
    const loc = String(r?.location || "").trim() || "(blank)";
    seen.set(loc, (seen.get(loc) || 0) + 1);
  }
}

const all = [...seen.entries()].sort((a, b) => b[1] - a[1]);
const kept = all.filter(([l]) => rooster.inSriLanka(l));
const dropped = all.filter(([l]) => !rooster.inSriLanka(l));
const n = (a) => a.reduce((s, [, c]) => s + c, 0);

console.log(`rows ${rows} · distinct location labels ${all.length}`);
console.log(`kept    ${String(n(kept)).padStart(4)} rows / ${kept.length} labels`);
console.log(`dropped ${String(n(dropped)).padStart(4)} rows / ${dropped.length} labels`);

// Which rule earned each kept row. If the city list is doing almost no
// work, that is worth knowing before anyone extends it.
const byCountry = kept.filter(([l]) => /\bsri\s*lanka\b/i.test(l));
const byRemote = kept.filter(([l]) => !/\bsri\s*lanka\b/i.test(l) && /\b(?:anywhere|worldwide|remote)\b/i.test(l));
const byCity = kept.filter(([l]) => !byCountry.includes(l) && !byRemote.includes(l)
  && !/\bsri\s*lanka\b/i.test(l) && !/\b(?:anywhere|worldwide|remote)\b/i.test(l));
console.log(`  named the country ${String(n(byCountry)).padStart(4)} rows / ${byCountry.length} labels`);
console.log(`  worldwide-remote  ${String(n(byRemote)).padStart(4)} rows / ${byRemote.length} labels`);
console.log(`  bare town name    ${String(n(byCity)).padStart(4)} rows / ${byCity.length} labels`);

console.log("\n-- DROPPED, most common first. Anything Sri Lankan here is a bug --");
for (const [l, c] of dropped) console.log(String(c).padStart(4), l);
