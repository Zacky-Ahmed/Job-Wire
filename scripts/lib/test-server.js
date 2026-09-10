// test-server.js
//
// A server the suite owns, on the test database, on its own port.
//
// e2e used to require you to have started a server yourself and then
// talked to localhost:3000 — which meant the suite seeded rows in one
// database while the server it was testing read another, and the only
// symptom was a sign-in that mysteriously failed. It also meant the
// suite could not restart the process, and the delivery work this
// precedes needs exactly that: kill it mid-send, start it again, prove
// nothing was lost.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { TEST_DB } from "./test-db.js";

const PORT = Number(process.env.TEST_PORT || 3100);
export const BASE = `http://localhost:${PORT}`;

/**
 * Start a server against the test database and wait for it to answer.
 *
 * The poller is off by default. A test that wants a sweep should call it
 * directly rather than wait for a background loop to decide to: a suite
 * racing a scheduler is a suite that fails on a slow machine.
 */
export async function startTestServer({ poller = false, mail = false, env = {} } = {}) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MONGODB_DB: TEST_DB,
      PORT: String(PORT),
      POLLER_ENABLED: String(poller),
      MAIL_ENABLED: String(mail),
      ...env,
    },
  });

  // Kept rather than piped through, so a failing suite can print what the
  // server said instead of leaving you to guess.
  const output = [];
  child.stdout.on("data", (d) => output.push(String(d)));
  child.stderr.on("data", (d) => output.push(String(d)));

  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      throw new Error(`test server exited early (${exited.code ?? exited.signal})\n${output.join("")}`);
    }
    try {
      const res = await fetch(BASE + "/healthz");
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`test server never answered /healthz\n${output.join("")}`);
    }
    await sleep(200);
  }

  return {
    base: BASE,
    child,
    log: () => output.join(""),
    /** SIGTERM, then wait — this is also how the shutdown tests measure it. */
    async stop({ signal = "SIGTERM", waitMs = 15_000 } = {}) {
      if (exited) return exited;
      child.kill(signal);
      const until = Date.now() + waitMs;
      while (!exited && Date.now() < until) await sleep(100);
      if (!exited) { child.kill("SIGKILL"); await sleep(300); }
      return exited;
    },
    /** For the crash-recovery tests: no cleanup, no chance to finish. */
    async kill() {
      if (exited) return exited;
      child.kill("SIGKILL");
      const until = Date.now() + 5_000;
      while (!exited && Date.now() < until) await sleep(50);
      return exited;
    },
  };
}
