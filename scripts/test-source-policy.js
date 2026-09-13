// scripts/test-source-policy.js
//
// Offline policy assertions. No live network calls, no Mongo connection.
// Run with: npm run test-policy
//
// Covers:
//   1. LinkedIn absent from source policy gate by default (no LINKEDIN_ACCESS_CONFIRMED)
//   2. LinkedIn passes when LINKEDIN_ACCESS_CONFIRMED=true
//   3. beforeRequest throws SourcePolicyError (not a network call) while disabled
//   4. 300/hour budget: transitions and resets correctly
//   5. 403/429 backoff: first block 60 min, doubles, caps at 1440 min
//   6. Non-LinkedIn sources have independent circuits
//   7. Honest User-Agent — not a Chrome/browser string

import assert from "node:assert/strict";
import { createSourcePolicy, SourcePolicyError } from "../src/services/http/sourcePolicy.js";
import { outboundUserAgent } from "../src/config/env.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  OK  " + name);
    passed++;
  } catch (err) {
    console.error("  FAIL " + name);
    console.error("      " + err.message);
    failed++;
  }
}

// ── 1. LinkedIn fail-closed gate ──────────────────────────────────────────────
console.log("\n1. LinkedIn fail-closed gate (LINKEDIN_ACCESS_CONFIRMED)");

test("beforeRequest throws when linkedinAccessConfirmed=false", () => {
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: false,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
  });
  assert.throws(
    () => policy.beforeRequest("linkedin.com"),
    (err) => err instanceof SourcePolicyError && /LINKEDIN_ACCESS_CONFIRMED/.test(err.message)
  );
});

test("beforeRequest passes when linkedinAccessConfirmed=true and budget available", () => {
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
  });
  assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"));
});

test("SOURCES_DISABLED blocks the source regardless of access confirmation", () => {
  const policy = createSourcePolicy({
    disabled: ["linkedin"], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
  });
  assert.throws(
    () => policy.beforeRequest("linkedin.com"),
    (err) => err instanceof SourcePolicyError && /disabled by SOURCES_DISABLED/.test(err.message)
  );
});

// ── 2. Zero network calls while disabled ──────────────────────────────────────
console.log("\n2. Direct fetchJobs — zero network requests while disabled");

test("SourcePolicyError is thrown synchronously (before any async I/O) when disabled", () => {
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: false,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
  });
  let threw = false;
  try {
    policy.beforeRequest("www.linkedin.com");
  } catch (err) {
    threw = true;
    assert.ok(err instanceof SourcePolicyError, "Must be SourcePolicyError");
    assert.equal(err.code, "SOURCE_POLICY");
  }
  assert.ok(threw, "Must throw before any network activity");
});

// ── 3. Hourly budget ──────────────────────────────────────────────────────────
console.log("\n3. LinkedIn hourly budget — 300 transitions and reset");

test("Budget: allows up to limit, rejects at limit+1", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 5, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"), "Request " + (i+1) + " should be allowed");
  }
  assert.throws(
    () => policy.beforeRequest("linkedin.com"),
    (err) => err instanceof SourcePolicyError && /budget exhausted/.test(err.message)
  );
});

test("Budget: resets after 1-hour window slides", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 3, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  for (let i = 0; i < 3; i++) policy.beforeRequest("linkedin.com");
  clock = 3600001;
  assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"), "Should allow after window resets");
});

// ── 4. Exponential backoff ────────────────────────────────────────────────────
console.log("\n4. Exponential 403/429 circuit backoff");

test("First block pauses for backoffMinutes (60 min)", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  policy.blocked("linkedin.com", null);
  assert.throws(() => policy.beforeRequest("linkedin.com"), "Should be blocked immediately after 403");
  clock = 59 * 60 * 1000;
  assert.throws(() => policy.beforeRequest("linkedin.com"), "Should still be blocked at 59 min");
  clock = 60 * 60 * 1000 + 1;
  assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"), "Should release after 60 min");
});

test("Second block doubles the pause (120 min)", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  policy.blocked("linkedin.com", null);
  clock = 61 * 60 * 1000;
  policy.blocked("linkedin.com", null);
  const secondBlockStart = clock;
  clock = secondBlockStart + 119 * 60 * 1000;
  assert.throws(() => policy.beforeRequest("linkedin.com"), "Should still be blocked at 119 min after 2nd block");
  clock = secondBlockStart + 120 * 60 * 1000 + 1;
  assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"), "Should release at 120 min after 2nd block");
});

test("Backoff caps at backoffMaxMinutes", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  // Force many doublings past the cap: 60->120->240->480->960->1440(cap)
  for (let i = 0; i < 6; i++) {
    policy.blocked("linkedin.com", null);
    clock += 2000 * 60 * 1000; // advance past any block
  }
  const lastBlockStart = clock;
  policy.blocked("linkedin.com", null);
  clock = lastBlockStart + 1441 * 60 * 1000;
  assert.doesNotThrow(() => policy.beforeRequest("linkedin.com"), "Backoff must not exceed 1440 min cap");
});

test("Non-LinkedIn sources are circuit-broken independently", () => {
  let clock = 0;
  const policy = createSourcePolicy({
    disabled: [], linkedinAccessConfirmed: true,
    linkedinBudgetPerHour: 300, backoffMinutes: 60, backoffMaxMinutes: 1440,
    now: () => clock,
  });
  policy.blocked("topjobs.lk", null);
  assert.throws(
    () => policy.beforeRequest("topjobs.lk"),
    (err) => err instanceof SourcePolicyError && /paused/.test(err.message),
    "topjobs should be blocked after 403"
  );
  assert.doesNotThrow(
    () => policy.beforeRequest("linkedin.com"),
    "LinkedIn should be unaffected by topjobs block"
  );
});

// ── 5. Honest User-Agent ──────────────────────────────────────────────────────
console.log("\n5. Honest User-Agent — not a browser impersonation string");

test("Default User-Agent does not contain Mozilla/Chrome/Safari", () => {
  const ua = outboundUserAgent();
  assert.ok(
    !ua.includes("Mozilla") && !ua.includes("Chrome") && !ua.includes("Safari"),
    "User-Agent must not impersonate a browser, got: " + ua
  );
  assert.ok(ua.startsWith("JobWire/"), "User-Agent must start with JobWire/, got: " + ua);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n" + "-".repeat(50));
if (failed === 0) {
  console.log("All " + passed + " policy assertions passed.\n");
  process.exit(0);
} else {
  console.log(failed + " of " + (passed + failed) + " assertions FAILED.\n");
  process.exit(1);
}