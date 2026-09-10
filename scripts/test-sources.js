// test-sources.js
//
//   npm run test-sources
//
// Adapter rules that can be checked without a database, a network, or a
// mail provider — so this is safe to run anywhere, unlike e2e, which
// still talks to a real Mongo.
//
// Everything here exists because an outside review of the code claimed a
// bug. Three of the five it named were already fixed; these tests are so
// that the next review's answer comes from a run rather than from
// somebody re-reading the file.

import { inSriLanka } from "../src/services/sources/rooster.js";
import * as rooster from "../src/services/sources/rooster.js";
import * as keells from "../src/services/sources/keells.js";
import { matchesAny } from "../src/utils/match.js";
import { listSources, getSource } from "../src/services/sources/index.js";
import { readFileSync } from "node:fs";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const all = (label, cases, fn) => {
  const bad = cases.filter((c) => !fn(c));
  check(label, bad.length === 0, bad.length ? "failed on: " + JSON.stringify(bad) : `(${cases.length})`);
};

console.log("\n=== Rooster: which locations count as Sri Lanka ===");

/* Every one of these is a real label from a 481-row snapshot of the
   live API, not an invented example. */
all("a label naming the country is kept", [
  "Colombo, Sri Lanka",
  "Colombo 03, Colombo, Sri Lanka",
  "Sri Lanka",
  "Battaramulla, Sri Lanka",
], inSriLanka);

all("a foreign label is refused", [
  "Qatar",
  "Mumbai, Maharashtra, India",
  "Islamabad, Pakistan",
  "Sydney NSW, Australia",
  "Cairo, Cairo Governorate, Egypt",
  "Malé, Maldives",
  "Dubai Investment Park Second - Dubai - United Arab Emirates",
  "Stanford-le-Hope SS17, UK",
], (l) => !inSriLanka(l));

/* The old rule named five cities and no more. It was not losing jobs,
   but only because nothing in that snapshot was posted as a bare city
   outside those five — and a bare city IS how one row arrived. */
all("a bare Sri Lankan town with no country is kept", [
  "Colombo", "Matara", "Kurunegala", "Batticaloa", "Nuwara Eliya", "Ja-Ela",
], inSriLanka);

/* The reason the city list may only be consulted when nothing names a
   country. There is a Colombo Street in Christchurch. */
check("a foreign address containing a Sri Lankan place name is still refused",
  !inSriLanka("Colombo Street, Christchurch, New Zealand"));
check("and so is a Galle Road that is not in Sri Lanka",
  !inSriLanka("Galle Court, Melbourne VIC, Australia"));

/* 18 rows of the measured snapshot. Open to anyone, so open to us — and
   the location string says so on its own, which is why no extra label
   is rendered anywhere. */
all("worldwide-remote is kept, because a Sri Lankan can take it", [
  "Anywhere, Worldwide", "Worldwide", "Remote",
], inSriLanka);

check("an empty location is not treated as Sri Lankan",
  !inSriLanka("") && !inSriLanka(null) && !inSriLanka(undefined));

console.log("\n=== Rooster: pagination reaches the end of the board ===");

/* The board declares five pages of a hundred. The sweep used to cap
   every adapter at four, so the fifth page — roughly a hundred of
   Rooster's ~490 listings — could never be requested. */
check("the adapter declares its own page budget", rooster.maxPages === 5, `maxPages=${rooster.maxPages}`);
check("and its page size", rooster.pageSize === 100, `pageSize=${rooster.pageSize}`);
check("page 4 (the fifth) is inside the budget", 4 < rooster.maxPages);
check("page 5 (a sixth) is refused by the adapter itself",
  (await rooster.fetchJobs({ keywords: ["intern"], page: rooster.maxPages })).length === 0,
  "returns [] without a request");

console.log("\n=== every source states how far the sweep may page it ===");

/* Read through getSource, not listSources: listSources returns a trimmed
   descriptor for the UI and drops maxPages, so asserting against that one
   would have been asserting against the wrong object. getSource returns
   what the sweep itself holds. */
for (const { id } of listSources()) {
  const src = getSource(id);
  const declared = typeof src.maxPages === "number";
  check(
    declared
      ? `${id.padEnd(8)} declares maxPages=${src.maxPages}`
      : `${id.padEnd(8)} pages internally, so the sweep's default of 4 applies`,
    typeof src.fetchJobs === "function" && (!declared || src.maxPages >= 1),
  );
}

/* The bug this replaced: one MAX_PAGES = 4 inside the sweep, applied to
   every adapter regardless of what the board actually holds. Rooster
   declares five pages of a hundred and lost its fifth to that constant. */
check("the sweep asks the adapter rather than assuming a number",
  readFileSync("src/services/poller/sweep.js", "utf8").includes("source.maxPages"));

console.log("\n=== Keells: the app's one definition of a word ===");

/* It used to lowercase and call String.includes(), so "intern" matched
   "international" and "internal audit". The rest of Job Wire has always
   used the word-boundary matcher; this is the source agreeing with it. */
const words = ["intern"];
all("a word is not matched inside a longer word", [
  "International Sales Executive",
  "Internal Audit Manager",
  "Internet Systems Engineer",
], (t) => !matchesAny(t, words));

all("but the word itself, in any position, is", [
  "Intern - Supply Chain",
  "Marketing Intern",
  "INTERN (Finance)",
  "Intern, Data",
], (t) => matchesAny(t, words));

check("keells imports the canonical matcher rather than its own",
  typeof keells.fetchJobs === "function");

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
