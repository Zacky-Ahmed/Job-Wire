// Offline regression tests: no LinkedIn requests, no production MongoDB.
import test from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/services/sources/linkedin.js";
import { retryAfterMs } from "../src/services/linkedin/sourceCooldown.js";
import { BlockedBySource } from "../src/services/http/guardedFetch.js";

function card(id) {
  return `<li class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a href="https://www.linkedin.com/jobs/view/${id}/"><h3 class="base-search-card__title">Software Intern</h3></a>
    <h4 class="base-search-card__subtitle">Example Company</h4>
    <span class="job-search-card__location">Colombo, Sri Lanka</span>
    <time datetime="2026-10-15">1 hour ago</time>
  </li>`;
}
const blocked = () => new BlockedBySource(429, "www.linkedin.com", "120");

test("successful pages survive a later LinkedIn HTTP 429", async () => {
  let requests = 0;
  const result = await collect((p) => String(p), {
    surfaceName: "testCountryFeed",
    fetchPage: async (url) => {
      requests++;
      if (Number(url) === 2) throw blocked();
      return card(400001 + Number(url));
    },
  });
  assert.equal(requests, 3);
  assert.deepEqual([...result.keys()], ["400001", "400002"]);
  assert.equal(result.tally.stopReason, "error_partial");
  assert.match(result.tally.error, /429/);
  assert.equal(result.tally.pageLog[2].page, 2);
  assert.equal(result.tally.pages, 2);
});

test("HTTP 429 on first page remains a failed crawl", async () => {
  await assert.rejects(
    collect(() => "first", { fetchPage: async () => { throw blocked(); } }),
    (err) => err.status === 429 && err.tally?.stopReason === "error",
  );
});

test("unrecognized later markup retains parsed jobs but marks degraded", async () => {
  const result = await collect((page) => String(page), {
    fetchPage: async (url) => Number(url) === 0
      ? card(400003)
      : "<html><body>Sign in to continue and verify identity</body></html>".repeat(20),
  });
  assert.equal(result.size, 1);
  assert.equal(result.tally.stopReason, "unrecognised_partial");
});

test("normal empty page completes without degradation", async () => {
  const result = await collect((page) => String(page), {
    fetchPage: async (url) => Number(url) === 0 ? card(400004) : "<!DOCTYPE html>\n\n<!---->",
  });
  assert.equal(result.size, 1);
  assert.equal(result.tally.stopReason, "empty");
});

test("Retry-After recognizes delay-seconds and HTTP dates, rejects nonsense", () => {
  const now = Date.parse("2026-10-15T08:00:00Z");
  assert.equal(retryAfterMs("120", now), 120000);
  assert.equal(retryAfterMs("Thu, 15 Oct 2026 08:02:00 GMT", now), 120000);
  assert.equal(retryAfterMs("nonsense", now), null);
  assert.equal(retryAfterMs("-1", now), null);
  assert.equal(retryAfterMs("99999999", now), 86400000);
});
