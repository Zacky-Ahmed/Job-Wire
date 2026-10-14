import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ejs from "ejs";
import {
  parseAdminSweepMinutes, effectiveSweepMinutes, adminIntervalPatch,
} from "../src/utils/sweepIntervals.js";

test("admin accepts minute-by-minute values including 5, 7, 8, 10 and 60", () => {
  for (const n of [5, 7, 8, 10, 60]) assert.equal(parseAdminSweepMinutes(String(n)), n);
  for (const invalid of ["", "4", "61", "7.5", "0", "1e1", "-1", "8;drop", null, 8]) {
    assert.equal(parseAdminSweepMinutes(invalid), null);
  }
  assert.equal(parseAdminSweepMinutes("7", 8), null);
  assert.equal(parseAdminSweepMinutes("8", 8), 8);
});

test("admin override takes precedence over a watch's requested interval", () => {
  assert.equal(effectiveSweepMinutes({ adminEveryMinutes: 10 }, 5), 10);
  assert.equal(effectiveSweepMinutes({ adminEveryMinutes: 7 }, 5), 7);
  assert.equal(effectiveSweepMinutes({ adminEveryMinutes: 8 }, 15), 8);
  assert.equal(effectiveSweepMinutes({}, 5), 5);
});

test("raising cadence extends the next scheduled sweep", () => {
  const now = new Date("2026-10-14T05:00:00Z");
  const row = {
    everyMinutes: 5,
    lastFetchedAt: new Date("2026-10-14T04:58:00Z"),
    nextFetchAt: new Date("2026-10-14T05:03:00Z"),
    failCount: 0,
  };
  assert.deepEqual(adminIntervalPatch(row, 10, now), {
    adminEveryMinutes: 10,
    everyMinutes: 10,
    nextFetchAt: new Date("2026-10-14T05:08:00Z"),
  });
});

test("lowering cadence pulls forward the next sweep without changing the past", () => {
  const now = new Date("2026-10-14T05:00:00Z");
  const row = {
    everyMinutes: 10,
    lastFetchedAt: new Date("2026-10-14T04:58:00Z"),
    nextFetchAt: new Date("2026-10-14T05:08:00Z"),
    failCount: 0,
  };
  assert.deepEqual(adminIntervalPatch(row, 7, now).nextFetchAt,
    new Date("2026-10-14T05:05:00Z"));
});

test("parked, in-flight and failing queries keep their current schedule", () => {
  const now = new Date("2026-10-14T05:00:00Z");
  const base = {
    everyMinutes: 5,
    lastFetchedAt: new Date("2026-10-14T04:57:00Z"),
    nextFetchAt: new Date("2026-10-14T05:02:00Z"),
  };
  for (const row of [
    { ...base, nextFetchAt: null },
    { ...base, nextFetchAt: new Date("2026-10-14T04:59:00Z") },
    { ...base, failCount: 1 },
  ]) {
    assert.deepEqual(adminIntervalPatch(row, 10, now),
      { adminEveryMinutes: 10, everyMinutes: 10 });
  }
});

test("admin queries panel renders an editable interval for shared watches", () => {
  const template = readFileSync(
    new URL("../src/views/partials/admin/queries.ejs", import.meta.url), "utf8"
  );
  const id = "64bf21593670f3d81c9ac107";
  const html = ejs.render(template, {
    csrfToken: "test-csrf",
    adminSweepMin: 5,
    packs: [],
    queryRows: [{
      id, label: "Intern", location: "Sri Lanka", sources: "linkedin, topjobs",
      matchAll: false, subscribers: 1, watchers: [], addable: [],
      tracked: 100, peak: 120, every: 10, adminEvery: 10, failCount: 0,
      retired: false, orphaned: false, stalled: false, duplicate: false,
      deletable: false, mergeTargets: [],
    }],
  });
  assert.ok(html.includes("/admin/queries/" + id + "/interval"));
  assert.match(html, /name="minutes"/);
  assert.match(html, /min="5" max="60" step="1"/);
  assert.match(html, /value="10" required/);
  assert.ok(html.includes("admin set"));
  assert.ok(html.includes('name="_csrf"'));
});
