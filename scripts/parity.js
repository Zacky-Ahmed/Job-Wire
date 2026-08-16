// parity.js
//
// Asks the only question that matters: does the wire show what the user's
// own LinkedIn search shows?
//
//   npm run parity -- Intern 100446352
//
// Every coverage failure this project has had was silent. A sweep
// "succeeded" and simply saw less, which looks exactly like a quiet
// morning, so the only thing that ever caught it was the user spotting a
// job on LinkedIn that never reached their inbox. This script is the
// system checking itself instead.
//
// It reads the PUBLIC search page — the same page a logged-out visitor
// gets at the URL the user pastes — and diffs it against what Job Wire
// would keep for the same watch. Two numbers matter:
//
//   MISSING   on LinkedIn, not in ours   -> we are failing the user
//   EXTRA     in ours, not on LinkedIn   -> we are spamming the user
//
// MISSING is the serious one. EXTRA is often LinkedIn being
// non-deterministic rather than us being wrong, so treat it as a prompt
// to look, not proof of a bug.

import * as cheerio from "cheerio";
import { getSource } from "../src/services/sources/index.js";
import { findGeo } from "../src/services/linkedin/geoIds.js";

const [keyword = "Intern", geoId = "100446352"] = process.argv.slice(2);
const geo = findGeo(geoId);
if (!geo) throw new Error(`Unknown geoId ${geoId}`);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page the user actually looks at, paginated. */
async function linkedInSearchPage() {
  const found = new Map();
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const url =
      `https://lk.linkedin.com/jobs/search?keywords=${encodeURIComponent(keyword)}` +
      `&location=${encodeURIComponent(geo.name)}&geoId=${geo.geoId}` +
      `&f_TPR=r86400&position=1&pageNum=${pageNum}&start=${pageNum * 25}`;

    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
    if (res.status !== 200) {
      console.log(`  ! LinkedIn answered ${res.status} on page ${pageNum} — results below are partial`);
      break;
    }
    const $ = cheerio.load(await res.text());
    const before = found.size;
    $("a[href*='/jobs/view/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const id = href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];
      if (!id) return;
      const card = $(a).closest("li, div.base-card");
      const title = (card.find("h3").first().text() || $(a).text()).replace(/\s+/g, " ").trim();
      if (id && !found.has(id)) found.set(id, title);
    });
    if (found.size === before) break;
    await wait(8000);
  }
  return found;
}

console.log(`\n  parity check — "${keyword}" in ${geo.name}, last 24h\n`);

const theirs = await linkedInSearchPage();
console.log(`  LinkedIn's own search page : ${theirs.size} jobs`);

const linkedin = getSource("linkedin");
const feed = await linkedin.fetchJobs({ keywords: [keyword], geoId });
console.log(`  our unfiltered sweep       : ${feed.length} jobs considered`);

const kept = await linkedin.refine(feed, { keywords: [keyword] });
const ours = new Map(kept.map((j) => [j.jobId.replace(/^linkedin:/, ""), j]));
console.log(`  our watch would keep       : ${ours.size} jobs\n`);

const missing = [...theirs].filter(([id]) => !ours.has(id));
const extra = [...ours].filter(([id]) => !theirs.has(id));
const overlap = theirs.size - missing.length;

console.log(`  MATCHED : ${overlap} of ${theirs.size}` +
  (theirs.size ? `  (${Math.round((overlap / theirs.size) * 100)}% of what LinkedIn shows)` : ""));

console.log(`\n  MISSING — on LinkedIn, not in ours (${missing.length}):`);
if (!missing.length) console.log("    none — we are not losing anything");
missing.forEach(([id, t]) => console.log(`    ${id}  ${t.slice(0, 58)}`));

console.log(`\n  EXTRA — in ours, not on that page (${extra.length}):`);
if (!extra.length) console.log("    none");
extra.forEach(([id, j]) => console.log(`    ${id}  ${String(j.matchedBy).padEnd(12)} ${j.title.slice(0, 46)}`));

console.log("");
process.exit(missing.length ? 1 : 0);
