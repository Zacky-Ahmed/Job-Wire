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

  // Search Console's ownership token. Public by design — it is meant to be
  // read by anyone who fetches the page — so it is not a secret, it just
  // does not belong hardcoded in a template. Accepts either the bare token
  // or the whole `google-site-verification=...` string people paste, since
  // pasting the full line is the usual way this gets entered wrong.
  googleSiteVerification: (process.env.GOOGLE_SITE_VERIFICATION || "")
    .trim()
    .replace(/^google-site-verification=/i, ""),

  // Who may open /admin. Deliberately an env var, not a database flag:
  // admin then cannot be granted by anything that can write to Mongo, and
  // there is no bootstrap problem of "who makes the first admin".
  // Comma-separated, compared case-insensitively.
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  mongoUri: required("MONGODB_URI"),
  mongoDb: process.env.MONGODB_DB || "jobwire",

  sessionSecret: required("SESSION_SECRET"),

  // Optional. When present, mail goes over Brevo's HTTPS API instead of
  // Gmail SMTP — required on hosts that block outbound SMTP ports.
  brevoApiKey: (process.env.BREVO_API_KEY || "").trim(),

  // Only required when Gmail is the transport. With BREVO_API_KEY set,
  // transport.js never touches these — but boot refused to start without
  // them anyway, so a Brevo-only deploy had to invent a Gmail account to
  // satisfy a check for credentials it would never use.
  gmailUser: (process.env.BREVO_API_KEY || "").trim()
    ? (process.env.GMAIL_USER || "").trim()
    : required("GMAIL_USER"),
  // Google displays the app password as 4 groups of 4; the secret is the 16 chars.
  gmailAppPassword: ((process.env.BREVO_API_KEY || "").trim()
    ? (process.env.GMAIL_APP_PASSWORD || "")
    : required("GMAIL_APP_PASSWORD")).replace(/\s+/g, ""),
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

// True when Gmail SMTP is the transport. Every Gmail-specific check
// below is conditioned on it: with Brevo configured these credentials are
// legitimately absent, and asserting on them turned an unused setting
// into a boot failure.
const usingGmail = !env.brevoApiKey;

// Catch the mistakes that produce confusing failures much later.
if (usingGmail && env.gmailAppPassword.length !== 16) {
  throw new Error(
    `GMAIL_APP_PASSWORD should be 16 characters after removing spaces, ` +
    `got ${env.gmailAppPassword.length}. Is it a real app password?`
  );
}
// Gmail silently rewrites a From that does not match the authenticated
// account, so a mismatch does not fail loudly — it just breaks DMARC
// alignment, which is exactly what pushes mail into spam. Warn rather
// than throw: a legitimately configured "Send mail as" alias is valid.
const fromAddress = ((env.mailFrom || "").match(/<([^>]+)>/)?.[1] || env.mailFrom || "")
  .trim().toLowerCase();
if (usingGmail && fromAddress !== env.gmailUser.toLowerCase()) {
  console.warn(
    `WARNING  MAIL_FROM address (${fromAddress}) does not match GMAIL_USER ` +
    `(${env.gmailUser}). Gmail will rewrite the From header, and the ` +
    `mismatch weakens DMARC alignment — expect more spam filtering. ` +
    `Make them the same unless ${fromAddress} is a verified "Send mail as" alias.`
  );
}

// Brevo hands out two credentials on the same screen and they are not
// interchangeable. The HTTP API (/v3/smtp/email) needs the REST key:
//
//   xkeysib-...    API key      <- what this app uses
//   xsmtpsib-...   SMTP key     <- username/password for the SMTP relay
//
// Pasting the SMTP key gives "401: Key not found" at send time, hours
// after the deploy looked fine, so name the mistake at boot instead.
if (env.brevoApiKey && env.brevoApiKey.startsWith("xsmtpsib-")) {
  throw new Error(
    "BREVO_API_KEY is an SMTP key (xsmtpsib-...), which the HTTP API rejects " +
    'with "401: Key not found". Generate a REST API key instead: Brevo > SMTP & API > ' +
    'the "API Keys" tab (not "SMTP"). It starts with xkeysib-.'
  );
}
if (env.brevoApiKey && !env.brevoApiKey.startsWith("xkeysib-")) {
  console.warn(
    `WARNING  BREVO_API_KEY does not start with "xkeysib-". If sends fail ` +
    `with 401, check you copied the API key rather than the SMTP key.`
  );
}

// Sending as a freemail address through a third party breaks DMARC
// alignment: gmail.com's own policy says only Google may send as
// gmail.com, so mail relayed by Brevo claims a domain it cannot prove.
// Gmail recipients — which is nearly everyone here — filter it hardest.
// Brevo flags this too, but a dashboard warning is easy to never revisit.
const FREEMAIL = /@(gmail|googlemail|yahoo|outlook|hotmail|live|aol|icloud|proton(mail)?)\./i;
if (env.brevoApiKey && FREEMAIL.test(fromAddress)) {
  console.warn(
    `WARNING  MAIL_FROM (${fromAddress}) is a freemail address being relayed ` +
    `through Brevo. DMARC cannot align, so Gmail and Outlook will filter ` +
    `these aggressively — including the verification codes new users need ` +
    `to sign up at all. Fix: register a domain, authenticate it in Brevo ` +
    `(SPF + DKIM), and send as alerts@yourdomain.`
  );
}

if (env.minSweepMinutes < 1) {
  throw new Error("MIN_SWEEP_MINUTES must be at least 1 — sub-minute polling will get you blocked.");
}
if (env.isProd && env.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET is too short for production. Use 32+ random characters.");
}
