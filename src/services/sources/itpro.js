// sources/itpro.js
//
// ITPro.lk — a Sri Lankan IT job board.
//
// The most precise clock of any source here. Every card carries a real
// timestamp in a <time datetime="2026-09-08T10:27:54+05:30"> attribute,
// offset and all, so "posted four minutes ago" means exactly that. Keells,
// topjobs and MAS print a bare date that resolves to midnight; LinkedIn
// gives a relative string that is only true at the moment it is read. This
// one is the only board that can be trusted to the minute.
//
// It is also the employer's own posting channel rather than an index of
// one, so a Colombo company can appear here before LinkedIn has indexed
// it at all — the same reason keells.js exists.
//
// Server-rendered HTML: the job titles are in the document, not fetched by
// script afterwards, so cheerio is enough and there is no API to depend on.

import * as cheerio from "cheerio";
import { observer, checkPageShape } from "./observe.js";
import { guardedFetch } from "../http/guardedFetch.js";
import { qualify } from "./index.js";
import { matchesAny } from "../../utils/match.js";

export const id = "itpro";
export const label = "ITPro.lk";
export const hosts = ["itpro.lk"];
export const perCountry = false;
export const countries = ["100446352"]; // Sri Lanka
export const note = "IT board — timestamps to the minute";
export const pageSize = 50;
// Pages internally: fetchJobs returns everything on page 0 and [] after,
// so the sweep must ask exactly once. Declared rather than inferred, because
// the sweep previously applied one guessed cap to every source alike.
export const maxPages = 1;
// The one local board that prints a time as well as a date.
export const timePrecision = "minute";

// The unfiltered listing, newest first. NOT /jobs/internship/: the type
// filter is the site's idea of a category, and a watch is matched on its
// own keywords — asking for one category would silently hide "Trainee
// Software Engineer" from an "intern" watch because the board filed it
// under Full-time.
const LIST = "https://itpro.lk/jobs/";

export async function fetchJobs({ keywords, page = 0, matchAll = false }) {
  // One page only. ?page=2 and /page/2/ both return page one — checked —
  // so paging would silently re-fetch the same fifty jobs for ever. Fifty
  // newest is the right window anyway for a sweep that runs every five
  // minutes; anything older has been seen already.
  const obs = observer(id);
  if (page > 0) return obs.done([]);

  const html = await guardedFetch(LIST, hosts, { jitter: true });
  const $ = cheerio.load(html);

  const cards = $("article.job-card");
  /* HTTP 200 is not the same as "the page we parse".

     One selector, article.job-card, stands between this adapter and
     silence. The site can rename that class in a redesign, keep
     answering 200, and this returns an empty array that reads as "no IT
     internships today" — for ever, and plausibly, because some days
     really do have none.

     The invariant is the container, not the count: if the listing
     element is on the page, zero cards is a real empty state. */
  const shape = checkPageShape({
    html,
    containerFound: cards.length > 0 || $(".job-list, .jobs, main").length > 0,
    rowsFound: cards.length,
    parsedCount: cards.length,
  });

  const out = [];
  cards.each((_, el) => {
    const $c = $(el);
    const rawId = $c.attr("id");
    if (!rawId) return;

    const title = $c.find(".jc-title").first().text().trim().replace(/\s+/g, " ");
    if (!title) return;

    const href = $c.find("a.jcl").first().attr("href");

    // "Colombo • Internship" — the city is what a reader wants; the
    // employment type is already implied by the watch that matched it.
    const meta = $c.find(".jc-company-info .la").first().text().trim().replace(/\s+/g, " ");
    const location = meta.split("\u2022")[0].trim();

    // The attribute, never the words beside it. "11 hours ago" is only
    // true at the moment the page was built; the datetime is absolute.
    const stamp = $c.find("time[datetime]").first().attr("datetime");
    const posted = stamp ? new Date(stamp) : null;

    out.push({
      jobId: qualify(id, rawId),
      title,
      company: $c.find(".jc-company").first().text().trim() || "ITPro.lk",
      location,
      url: href ? new URL(href, LIST).toString() : `https://itpro.lk/job/${rawId}/`,
      postedText: $c.find("time").first().text().trim().replace(/\s+/g, " "),
      postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : null,
    });
  });

  obs.surface("listing", {
    ok: shape.ok, requests: 1, pages: 1,
    rawCount: cards.length, parsedCount: out.length,
    error: shape.ok ? null : shape.error,
  });
  /* This board only ever exposes its newest page, so a long outage is
     not recoverable from it: whatever scrolled off while the poller was
     down is gone as far as this source is concerned. Said out loud on
     every observation, because it is a property of the source rather
     than a fault, and nothing else in the system would reveal it. */
  obs.note("only the newest page is exposed — an outage longer than its churn loses jobs here");

  if (matchAll) return obs.done(out);
  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
  if (!words.length) return obs.done(out);
  return obs.done(out.filter((j) => matchesAny(j.title, words)));
}
