// Regression tests: email links must open the durable Job Wire copy first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ejs from "ejs";
import { jobDetailsUrl, safeApplyUrl } from "../src/utils/jobLinks.js";

const first = "64bf21593670f3d81c9ac107";
const second = "64bf21593670f3d81c9ac108";
const origin = "https://jobwire.me";

test("job details links use a validated outbox id and configured site", () => {
  assert.equal(jobDetailsUrl(first, origin + "/"), origin + "/job/" + first);
  assert.equal(jobDetailsUrl("not-an-id", origin), null);
  assert.equal(jobDetailsUrl(first, "javascript:alert(1)"), null);
  assert.equal(jobDetailsUrl(first, "https://person:pass@jobwire.me"), null);
});

test("official apply links reject scripts and non-HTTP schemes", () => {
  assert.equal(safeApplyUrl("https://company.example/apply?ref=123"),
    "https://company.example/apply?ref=123");
  assert.equal(safeApplyUrl("javascript:alert(1)"), null);
  assert.equal(safeApplyUrl("data:text/html,hi"), null);
  assert.equal(safeApplyUrl("https://user:pass@company.example/apply"), null);
});

test("alert email uses distinct Job Wire links in HTML and plaintext", async () => {
  process.env.MONGODB_URI ||= "mongodb://localhost:27017/test";
  process.env.SESSION_SECRET ||= "test-session-secret";
  // buildAlert only formats messages. No transport is used by this test.
  process.env.BREVO_API_KEY ||= "dummy-key-for-format-only-tests";
  process.env.APP_URL = origin;
  const { buildAlert } = await import("../src/services/mail/send.js");
  const jobs = [first, second].map((detailId, i) => ({
    detailId,
    jobId: "linkedin:" + (i + 1),
    title: "Engineering Intern " + (i + 1),
    company: "Sample employer",
    location: "Colombo",
    url: "https://www.linkedin.com/jobs/view/" + (i + 1),
    postedAt: new Date(),
  }));
  const mail = buildAlert({ label: "Intern", jobs });
  for (const id of [first, second]) {
    assert.ok(mail.html.includes(origin + "/job/" + id));
    assert.ok(mail.text.includes(origin + "/job/" + id));
  }
  assert.ok(mail.html.includes("View job on Job Wire"));
  assert.ok(!mail.html.includes("https://www.linkedin.com/jobs/view/"));
});

test("public page escapes hostile metadata and never exposes private fields", () => {
  const template = readFileSync(new URL("../src/views/pages/job.ejs", import.meta.url), "utf8");
  const html = ejs.render(template, {
    theme: "light", title: "<script>alert(1)</script>",
    asset: (path) => path,
    sourceLabel: "LinkedIn",
    postedDate: "14 October 2026",
    applyUrl: safeApplyUrl("https://example.com/apply"),
    job: {
      title: "<script>alert(1)</script>",
      company: "Example", location: "Colombo",
      description: "", openings: 1,
    },
  });
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("this source did not provide a full description"));
  assert.ok(html.includes('href="https://example.com/apply"'));
  assert.ok(html.includes('name="robots" content="noindex,nofollow"'));
  assert.ok(!html.includes("subscriptionId"));
  assert.ok(!html.includes("userId"));
});
