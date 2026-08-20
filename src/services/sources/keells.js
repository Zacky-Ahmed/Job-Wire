// sources/keells.js
//
// John Keells Group's own careers site. One employer, but a big one —
// and unlike LinkedIn it publishes with NO search-index lag, so a
// posting appears here the moment it goes live. Often before LinkedIn.
//
// Server-rendered HTML, so the same cheerio approach as LinkedIn. The
// selectors were read off the live page: each result is a
// tr.data-row with colTitle / colLocation / colDepartment / colDate.
//
// Sri Lanka only. The UI hides it for any other country rather than
// silently returning nothing.

import * as cheerio from "cheerio";
import { guardedFetch } from "../http/guardedFetch.js";
import { qualify } from "./index.js";

export const id = "keells";
export const label = "John Keells Group";
export const hosts = ["careers.keells.com"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka
export const note = "Publishes instantly — no search-index delay";
export const pageSize = 10;
// The board prints a DATE and nothing finer ("19 Aug 2026"), which
// resolves to midnight. A job posted at nine this morning therefore reads
// as several hours old the moment it appears, so its age cannot be used
// to judge whether it is news. Its arrival is the only signal there is.
export const timePrecision = "day";

const BASE = "https://careers.keells.com/search/";

/** "20 Jul 2026" -> Date. Their listings carry a date but no time. */
function parseDate(text) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/.exec((text || "").trim());
  if (!m) return null;
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mon = months[m[2].toLowerCase().slice(0, 3)];
  if (mon === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fetchJobs({ keywords, page = 0 }) {
  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  const q = words.join(" ") || "intern";

  const params = new URLSearchParams({ q });
  if (page > 0) params.set("startrow", String(page * pageSize));

  const html = await guardedFetch(`${BASE}?${params}`, hosts, { jitter: page === 0 });
  const $ = cheerio.load(html);

  const rows = $('tr[class*="data-row"]');
  // No rows at all on page 0 is a legitimate "no results"; on a later
  // page it just means we reached the end.
  if (!rows.length) return [];

  const out = [];
  rows.each((_, el) => {
    const $r = $(el);
    const $a = $r.find('a[href*="/job/"]').first();
    const href = $a.attr("href");
    if (!href) return;

    // /JohnKeellsIT/job/Colombo-Intern-HR-Operations/1364562766/
    const rawId = href.match(/\/(\d{6,})\/?$/)?.[1];
    if (!rawId) return;

    const title = $a.text().trim().replace(/\s+/g, " ");
    if (!title) return;

    const dateText = $r.find(".colDate").text().trim();
    out.push({
      jobId: qualify(id, rawId),
      title,
      company: $r.find(".colDepartment").text().trim() || "John Keells Group",
      location: $r.find(".colLocation").text().trim(),
      url: new URL(href, BASE).toString(),
      postedText: dateText,
      postedAt: parseDate(dateText),
    });
  });

  // Their search is broad — a query for "intern" also returns senior
  // roles. Keep anything whose title actually contains a keyword, so a
  // watch for "intern" does not alert on "Senior Consultant".
  if (!words.length) return out;
  const needles = words.map((w) => w.toLowerCase());
  return out.filter((j) => {
    const t = j.title.toLowerCase();
    return needles.some((n) => t.includes(n));
  });
}
