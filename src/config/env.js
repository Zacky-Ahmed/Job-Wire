// env.js
//
// Reads and validates process.env. Throws loudly at boot if anything
// required is missing — never fail silently at 3am.

import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var: ${name}\n` +
      `Copy .env.example to .env and fill it in.`
    );
  }
  return v.trim();
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = (process.env[name] || "").toLowerCase().trim();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  port: num("PORT", 3000),
  appUrl: process.env.APP_URL || "http://localhost:3000",

  mongoUri: required("MONGODB_URI"),
  mongoDb: process.env.MONGODB_DB || "jobwire",

  sessionSecret: required("SESSION_SECRET"),

  gmailUser: required("GMAIL_USER"),
  // Google displays the app password as 4 groups of 4; the secret is the 16 chars.
  gmailAppPassword: required("GMAIL_APP_PASSWORD").replace(/\s+/g, ""),
  mailFrom: process.env.MAIL_FROM || process.env.GMAIL_USER,

  pollTickSeconds: num("POLL_TICK_SECONDS", 30),
  defaultSweepMinutes: num("DEFAULT_SWEEP_MINUTES", 5),
  minSweepMinutes: num("MIN_SWEEP_MINUTES", 2),
  fetchJitterMs: num("FETCH_JITTER_MS", 4000),
  maxFailCount: num("MAX_FAIL_COUNT", 6),
  pollerEnabled: bool("POLLER_ENABLED", true),

  // How long a job stays in seenJobs before it can be "new" again.
  // Must outlive any realistic posting, or you re-alert on old jobs.
  seenJobTtlDays: num("SEEN_JOB_TTL_DAYS", 14),
};

// Catch the mistakes that produce confusing failures much later.
if (env.gmailAppPassword.length !== 16) {
  throw new Error(
    `GMAIL_APP_PASSWORD should be 16 characters after removing spaces, ` +
    `got ${env.gmailAppPassword.length}. Is it a real app password?`
  );
}
// Gmail silently rewrites a From that does not match the authenticated
// account, so a mismatch does not fail loudly — it just breaks DMARC
// alignment, which is exactly what pushes mail into spam. Warn rather
// than throw: a legitimately configured "Send mail as" alias is valid.
const fromAddress = (env.mailFrom.match(/<([^>]+)>/)?.[1] || env.mailFrom).trim().toLowerCase();
if (fromAddress !== env.gmailUser.toLowerCase()) {
  console.warn(
    `WARNING  MAIL_FROM address (${fromAddress}) does not match GMAIL_USER ` +
    `(${env.gmailUser}). Gmail will rewrite the From header, and the ` +
    `mismatch weakens DMARC alignment — expect more spam filtering. ` +
    `Make them the same unless ${fromAddress} is a verified "Send mail as" alias.`
  );
}

if (env.minSweepMinutes < 1) {
  throw new Error("MIN_SWEEP_MINUTES must be at least 1 — sub-minute polling will get you blocked.");
}
if (env.isProd && env.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET is too short for production. Use 32+ random characters.");
}
