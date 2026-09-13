// Offline regression checks: fake credentials, mocked outbound I/O, loopback HTTP.
import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns/promises";
import express from "express";
import { mountHealth } from "../src/routes/health.js";
import { nextSlot } from "../src/services/poller/schedule.js";
import { readBody } from "../src/services/http/readBody.js";

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: "__no_dotenv_for_tests__", NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:1", MONGODB_DB: "jobwire_test",
  SESSION_SECRET: "offline-test-secret", GMAIL_USER: "test@example.com",
  GMAIL_APP_PASSWORD: "abcdefghijklmnop", MAIL_FROM: "test@example.com",
  BREVO_API_KEY: "", SOURCES_DISABLED: "linkedin", FETCH_JITTER_MS: "0",
  POLLER_ENABLED: "false", PORT: "3000", DEFAULT_SWEEP_MINUTES: "5",
  MIN_SWEEP_MINUTES: "5",
});
const { createSourcePolicy, SOURCE_HOSTS } = await import("../src/services/http/sourcePolicy.js");
const { guardedFetch } = await import("../src/services/http/guardedFetch.js");
const { fetchLinkedIn } = await import("../src/services/linkedin/fetch.js");

test("chunked response is stopped at the byte ceiling and cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBody(new Response(stream), 10), /too large/);
  assert.equal(cancelled, true);
  assert.equal((await readBody(new Response("small"), 10)).toString(), "small");
});

test("every disabled source is denied, including subdomains", () => {
  for (const [source, hosts] of Object.entries(SOURCE_HOSTS)) {
    const gate = createSourcePolicy({ disabled: [source] });
    for (const host of hosts) {
      assert.throws(() => gate.beforeRequest(host), /disabled/);
      assert.throws(() => gate.beforeRequest(`www.${host}`), /disabled/);
    }
  }
});

test("rolling request budget does not reset at an hour boundary", () => {
  let clock = 3599000;
  const gate = createSourcePolicy({ now: () => clock, linkedinRequestsPerHour: 2 });
  gate.beforeRequest("linkedin.com");
  gate.beforeRequest("www.linkedin.com");
  clock = 3601000;
  assert.throws(() => gate.beforeRequest("linkedin.com"), /budget/);
  gate.beforeRequest("topjobs.lk");
  clock = 7199000;
  gate.beforeRequest("linkedin.com");
});

test("source cooldown honors Retry-After and isolates healthy sources", () => {
  let clock = 100000;
  const gate = createSourcePolicy({ now: () => clock, cooldownMs: 1000 });
  gate.blocked("www.linkedin.com", "120");
  clock += 2000;
  assert.throws(() => gate.beforeRequest("linkedin.com"), /paused/);
  gate.beforeRequest("topjobs.lk");
  clock += 118000;
  gate.beforeRequest("linkedin.com");
  gate.blocked("linkedin.com", new Date(clock + 60000).toUTCString());
  assert.throws(() => gate.beforeRequest("www.linkedin.com"), /paused/);
});

test("direct and legacy LinkedIn paths cannot bypass disabled-source policy", async () => {
  const original = dns.lookup;
  dns.lookup = async () => { throw new Error("DNS must not be reached"); };
  try {
    await assert.rejects(guardedFetch("https://www.linkedin.com/jobs/search", ["linkedin.com"]), /disabled/);
    await assert.rejects(fetchLinkedIn("https://www.linkedin.com/jobs/search"), /disabled/);
  } finally { dns.lookup = original; }
});

test("403 blocks subsequent requests before DNS or fetch, including another path", async () => {
  const originalDns = dns.lookup;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  dns.lookup = async () => [{ address: "8.8.8.8" }];
  globalThis.fetch = async () => { calls++; return new Response("blocked", { status: 403 }); };
  try {
    await assert.rejects(guardedFetch("https://topjobs.lk/one", ["topjobs.lk"]), /403/);
    await assert.rejects(guardedFetch("https://topjobs.lk/two", ["topjobs.lk"]), /paused/);
    assert.equal(calls, 1);
  } finally { dns.lookup = originalDns; globalThis.fetch = originalFetch; }
});

test("fixed slots advance strictly into the future at exact boundaries", () => {
  for (const now of [0, 299999, 300000, 600000, 1500000]) {
    const slot = nextSlot({ scheduledFor: new Date(0), intervalMs: 300000, now });
    assert.ok(slot.at.getTime() > now);
    assert.equal(slot.at.getTime() % 300000, 0);
  }
});

test("redirect cannot reach a disabled source", async () => {
  const originalDns = dns.lookup;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  dns.lookup = async () => [{ address: "8.8.8.8" }];
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://linkedin.com/jobs" } });
  };
  try {
    await assert.rejects(guardedFetch("https://xpress.jobs/start", ["xpress.jobs", "linkedin.com"]), /disabled/);
    assert.equal(calls, 1);
  } finally { dns.lookup = originalDns; globalThis.fetch = originalFetch; }
});

test("request timeout remains active while a response body stalls", { timeout: 2000 }, async () => {
  const originalDns = dns.lookup;
  const originalFetch = globalThis.fetch;
  const originalTimer = globalThis.setTimeout;
  dns.lookup = async () => [{ address: "8.8.8.8" }];
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 15000 ? 10 : ms, ...args);
  globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
    },
  }));
  try {
    await assert.rejects(guardedFetch("https://itpro.lk/slow", ["itpro.lk"]), /body aborted/);
  } finally {
    dns.lookup = originalDns;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimer;
  }
});

test("health is session-free and readiness follows initialization, DB and shutdown", async () => {
  const app = express();
  let dbUp = true;
  mountHealth(app, { ping: async () => { if (!dbUp) throw new Error("private DB error"); } });
  app.use(() => { throw new Error("health must bypass session middleware"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("set-cookie"), null);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    app.locals.ready = true;
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    dbUp = false;
    const failed = await fetch(`${base}/readyz`);
    assert.equal(failed.status, 503);
    assert.equal(await failed.text(), "not ready");
    dbUp = true;
    app.locals.shuttingDown = true;
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
