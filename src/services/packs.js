// packs.js
//
// Named narrowings a watch can apply to its OWN email.
//
// The problem a pack solves is that one role has many titles. A Data
// Science student wants "Intern - Data Engineering", "Machine Learning
// Engineer Intern" and "Business Intelligence Trainee" and does not want
// "Intern - Human Resources" — and no single keyword expresses that,
// because a watch's keywords are OR'd. Watching "intern, data analyst"
// asks for interns OR analysts and delivers every one of both.
//
// So a pack is the AND half. The watch keyword decides what is a job worth
// looking at; the pack decides whether it is about the right subject.
//
// WHERE IT LIVES MATTERS. A pack belongs to a SUBSCRIPTION, not to a query.
// Put it on the query and the watch becomes a different search: its own
// row, its own sweep, its own priming pass, and a share of the cycle
// everybody else queues behind. On the subscription it changes nothing
// about what is fetched — twenty people on one "intern" search still cost
// one fetch — and only narrows what is handed to each of them at the end.
//
// It narrows EMAIL only. The wire keeps showing everything the watch
// caught, because the complaint packs exist to fix is inbox noise, not
// having too much to look at when you deliberately open the page.
//
// Words are matched against the TITLE with the same rule as a keyword:
// word boundaries plus ordinary endings, so "analytics" reaches analytic
// and "data engineer" reaches data engineers.

import { matchesAny } from "../utils/match.js";

/* Deliberately phrases, not bare words.
 *
 * "data" on its own matches Data Entry Operator, which is not data
 * science by any reading — so every data term here carries its second
 * word. The same reasoning keeps "analyst" out while "data analyst" and
 * "business analyst" are in. */
export const PACKS = {
  "data-science": {
    id: "data-science",
    label: "Data Science",
    note: "Interns in data, ML, AI, BI, cloud and software engineering",
    words: [
      // the core specialisation
      "data science", "data scientist", "data analyst", "data analytics",
      "analytics", "business analytics", "business analyst",
      "machine learning", "deep learning", "ml engineer",
      "artificial intelligence", "ai", "ai engineer", "ai/ml",
      "nlp", "computer vision", "data mining",
      // the engineering side of it
      "data engineer", "data engineering", "big data", "etl",
      "data architect", "data warehouse",
      "business intelligence", "power bi", "tableau",
      // the platform roles the same students take
      "database", "dba", "sql", "cloud", "aws", "azure", "devops",
      // and the software roles, which are on the same list
      "software engineer", "software engineering", "software development",
      "backend", "back end", "back-end", "full stack", "fullstack",
      "python", "web developer", "software developer",
    ],
  },
};

/** Every pack, for a picker. */
export function listPacks() {
  return Object.values(PACKS).map((p) => ({ id: p.id, label: p.label, note: p.note }));
}

export function getPack(id) {
  return PACKS[String(id || "")] || null;
}

/**
 * Should this job reach a subscriber with this pack set?
 *
 * No pack means no narrowing, which is the default and the behaviour
 * every existing watch already has. An id that no longer exists also
 * means no narrowing: a pack removed from the code must not silently
 * mute somebody's alerts.
 */
export function passesPack(title, packId) {
  if (!packId) return true;
  const pack = getPack(packId);
  if (!pack) return true;
  return matchesAny(title, pack.words);
}
