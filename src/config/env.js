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
  host: process.env.HOST || "0.0.0.0",
  trustProxyHops: num("TRUST_PROXY_HOPS", 1),
  appUrl: process.env.APP_URL || "http://localhost:3000",

  // ── LinkedIn source policy ────────────────────────────────────
  //
  // LINKEDIN_ACCESS_CONFIRMED is an operator attestation — not a technical
  // permission grant — that written LinkedIn authorization or a licensed
  // arrangement covers the intended collection, storage, display, alerting
  // and volume. Default false: LinkedIn is excluded from the source registry
  // and the adapter itself refuses network calls unless this is set to true.
  linkedinAccessConfirmed: bool("LINKEDIN_ACCESS_CONFIRMED", false),

  // Deployment-wide HTTP transaction ceiling for LinkedIn, including redirect
  // hops. 300 is a conservative safety ceiling close to the calculated
  // pre-scheduler envelope (~265 listing calls/hour plus ~11 detail/hour);
  // NOT a claim about an approved rate or actual past traffic. Any authorized
  // integration limit overrides it downward. Do not raise to defeat a block.
  linkedinRequestBudgetPerHour: num("LINKEDIN_REQUEST_BUDGET_PER_HOUR", 300),

  // Exponential circuit breaker for LinkedIn 403/429 responses.
  // First block pauses BACKOFF_MINUTES (default 60). Each subsequent block in
  // the same process lifetime doubles the pause, capped at BACKOFF_MAX_MINUTES
  // (default 1440 = 24h). Risk control, not a way to defeat enforcement.
  linkedinBlockedBackoffMinutes: num("LINKEDIN_BLOCKED_BACKOFF_MINUTES", 60),
  linkedinBlockedBackoffMaxMinutes: num("LINKEDIN_BLOCKED_BACKOFF_MAX_MINUTES", 1440),

  // ── Outbound HTTP identification ──────────────────────────────
  // Honest, configurable application identifier for permitted integrations.
  // Not a browser impersonation string. Jitter is burst-spreading only.
  // Resolved lazily via outboundUserAgent() so appUrl is available.
  _outboundUserAgentRaw: (process.env.OUTBOUND_USER_AGENT || "").trim(),

  // ── Mail ──────────────────────────────────────────────────────
  // When false: verifyTransport() and sendMail() are no-ops; provider
  // credentials are not required at boot. Use for read-only staging or
  // offline tests. Set true on any instance that must send alerts.
  mailEnabled: bool("MAIL_ENABLED", true),

  // Search Console ownership token. Public by design.
  googleSiteVerification: (process.env.GOOGLE_SITE_VERIFICATION || "")
    .trim()
    .replace(/^google-site-verification=/i, ""),

  // Who may open /admin. Env var, not a DB flag.
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  mongoUri: required("MONGODB_URI"),
  mongoDb: process.env.MONGODB_DB || "jobwire",

  sessionSecret: required("SESSION_SECRET"),

  // Controls dns.setDefaultResultOrder(). "verbatim" preserves the resolver
  // order. "ipv4first" for hosts without outbound IPv6 routing. Change only
  // for a documented host constraint.
  dnsResultOrder: (process.env.DNS_RESULT_ORDER || "verbatim").trim(),

  // Optional Brevo HTTPS API key. When set, mail uses HTTPS instead of SMTP.
  brevoApiKey: (process.env.BREVO_API_KEY || "").trim(),

  // Gmail credentials only required when MAIL_ENABLED=true and no Brevo key.
  gmailUser: (() => {
    if (!bool("MAIL_ENABLED", true)) return (process.env.GMAIL_USER || "").trim();
    if ((process.env.BREVO_API_KEY || "").trim()) return (process.env.GMAIL_USER || "").trim();
    return required("GMAIL_USER");
  })(),
  gmailAppPassword: (() => {
    const raw = process.env.GMAIL_APP_PASSWORD || "";
    if (!bool("MAIL_ENABLED", true)) return raw.replace(/\s+/g, "");
    if ((process.env.BREVO_API_KEY || "").trim()) return raw.replace(/\s+/g, "");
    return required("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
  })(),
  mailFrom: process.env.MAIL_FROM || process.env.GMAIL_USER,

  pollTickSeconds: num("POLL_TICK_SECONDS", 30),
  defaultSweepMinutes: num("DEFAULT_SWEEP_MINUTES", 5),
  minSweepMinutes: num("MIN_SWEEP_MINUTES", 5),
  fetchJitterMs: num("FETCH_JITTER_MS", 4000),
  maxFailCount: num("MAX_FAIL_COUNT", 6),
  pollerEnabled: bool("POLLER_ENABLED", true),
  disabledSources: (process.env.SOURCES_DISABLED || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  deliveryTickSeconds: num("DELIVERY_TICK_SECONDS", 15),
  shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 120000),

  seenJobTtlDays: num("SEEN_JOB_TTL_DAYS", 14),
  alertTtlDays: num("ALERT_TTL_DAYS", 1095),
  staleAlertDays: num("STALE_ALERT_DAYS", 90),

  starterWatchKeywords: (process.env.STARTER_WATCH_KEYWORDS ?? "intern").trim(),
  starterWatchGeoId: (process.env.STARTER_WATCH_GEO_ID ?? "100446352").trim(),
  starterWatchLabel: (process.env.STARTER_WATCH_LABEL ?? "Intern").trim(),
};

/** Honest outbound User-Agent, resolved after appUrl is populated. */
export function outboundUserAgent() {
  if (env._outboundUserAgentRaw) return env._outboundUserAgentRaw;
  return `JobWire/0.1 (+${env.appUrl})`;
}

// ── Validation ────────────────────────────────────────────────────────────────

const usingGmail = !env.brevoApiKey;

if (env.mailEnabled && usingGmail && env.gmailAppPassword.length !== 16) {
  throw new Error(
    `GMAIL_APP_PASSWORD should be 16 characters after removing spaces, ` +
    `got ${env.gmailAppPassword.length}. Is it a real app password?`
  );
}
const fromAddress = ((env.mailFrom || "").match(/<([^>]+)>/)?.[1] || env.mailFrom || "")
  .trim().toLowerCase();
if (env.mailEnabled && usingGmail && fromAddress !== (env.gmailUser || "").toLowerCase()) {
  console.warn(
    `WARNING  MAIL_FROM address (${fromAddress}) does not match GMAIL_USER ` +
    `(${env.gmailUser}). Gmail will rewrite the From header, and the ` +
    `mismatch weakens DMARC alignment — expect more spam filtering. ` +
    `Make them the same unless ${fromAddress} is a verified "Send mail as" alias.`
  );
}

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

const FREEMAIL = /@(gmail|googlemail|yahoo|outlook|hotmail|live|aol|icloud|proton(mail)?)\./ ;
if (env.brevoApiKey && FREEMAIL.test(fromAddress)) {
  console.warn(
    `WARNING  MAIL_FROM (${fromAddress}) is a freemail address being relayed ` +
    `through Brevo. DMARC cannot align, so Gmail and Outlook will filter ` +
    `these aggressively. Fix: register a domain, authenticate it in Brevo ` +
    `(SPF + DKIM), and send as alerts@yourdomain.`
  );
}

if (env.minSweepMinutes < 1) {
  throw new Error("MIN_SWEEP_MINUTES must be at least 1 — sub-minute polling will get you blocked.");
}
if (env.defaultSweepMinutes < env.minSweepMinutes) {
  throw new Error(
    `DEFAULT_SWEEP_MINUTES (${env.defaultSweepMinutes}) is below MIN_SWEEP_MINUTES ` +
    `(${env.minSweepMinutes}) — the default must be a value the slider can reach.`
  );
}
if (env.isProd && env.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET is too short for production. Use 32+ random characters.");
}

const validDnsOrders = ["verbatim", "ipv4first", "ipv6first"];
if (!validDnsOrders.includes(env.dnsResultOrder)) {
  throw new Error(`DNS_RESULT_ORDER must be one of: ${validDnsOrders.join(", ")}`);
}

for (const [name, value, min, max] of [
  ["PORT", env.port, 1, 65535],
  ["TRUST_PROXY_HOPS", env.trustProxyHops, 0, 10],
  ["LINKEDIN_REQUEST_BUDGET_PER_HOUR", env.linkedinRequestBudgetPerHour, 1, 100000],
  ["LINKEDIN_BLOCKED_BACKOFF_MINUTES", env.linkedinBlockedBackoffMinutes, 1, 1440],
  ["LINKEDIN_BLOCKED_BACKOFF_MAX_MINUTES", env.linkedinBlockedBackoffMaxMinutes, 1, 10080],
  ["POLL_TICK_SECONDS", env.pollTickSeconds, 1, 86400],
  ["DELIVERY_TICK_SECONDS", env.deliveryTickSeconds, 1, 86400],
  ["SHUTDOWN_GRACE_MS", env.shutdownGraceMs, 1000, 600000],
]) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}
if (env.linkedinBlockedBackoffMinutes > env.linkedinBlockedBackoffMaxMinutes) {
  throw new Error(
    `LINKEDIN_BLOCKED_BACKOFF_MINUTES (${env.linkedinBlockedBackoffMinutes}) ` +
    `exceeds LINKEDIN_BLOCKED_BACKOFF_MAX_MINUTES (${env.linkedinBlockedBackoffMaxMinutes})`
  );
}
const knownSources = ["linkedin", "keells", "topjobs", "mas", "itpro", "xpress", "rooster"];
if (env.disabledSources.some((id) => !knownSources.includes(id))) {
  throw new Error("SOURCES_DISABLED contains an unknown source; check spelling");
}
if (env.mailEnabled && !env.mailFrom?.trim()) {
  throw new Error("MAIL_FROM is required when MAIL_ENABLED=true");
}
