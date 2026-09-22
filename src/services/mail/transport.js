// transport.js
//
// The ONLY file that knows which email provider is in use.
//
// Brevo remains the preferred transport when configured. When Gmail SMTP
// credentials are ALSO configured, Brevo's account endpoint is checked
// before a new message is assigned to it. If Brevo reports zero remaining
// send credits (or the account check itself is unavailable), a NEW message
// is routed through Gmail instead.
//
// Alert batches pin that decision in the durable outbox. That matters:
// after Brevo has been called, a timeout is ambiguous — it may have
// accepted the message even if we never received the response. Retrying
// that same batch through Gmail could therefore send a duplicate. The
// outbox keeps retries on the provider chosen before the first attempt.
//
// Gmail SMTP still works as the sole provider when BREVO_API_KEY is empty.

import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_ACCOUNT_ENDPOINT = "https://api.brevo.com/v3/account";
const CREDIT_CACHE_MS = 60_000;

const gmailConfigured = () => !!(env.gmailUser && env.gmailAppPassword);

export function providerName() {
  if (env.brevoApiKey && gmailConfigured()) return "auto(brevo→gmail)";
  return env.brevoApiKey ? "brevo(http)" : "gmail(smtp)";
}

/**
 * Conservative instance-wide ceiling.
 *
 * With both providers configured, 450 is deliberately NOT the sum of
 * their limits. If Brevo starts the day already exhausted, every message
 * may go through Gmail; keeping the ceiling at Gmail's existing headroom
 * prevents the fallback from being allowed to spend 700+ messages through
 * one personal account merely because Brevo is configured.
 */
export function dailyCap() {
  if (env.brevoApiKey && gmailConfigured()) return 450;
  return env.brevoApiKey ? 280 : 450;
}

/** Short label for the UI: no version numbers, no transport jargon. */
export function providerLabel() {
  if (env.brevoApiKey && gmailConfigured()) return "Brevo + Gmail";
  return env.brevoApiKey ? "Brevo" : "Gmail";
}

/** Splits "Job Wire <a@b.com>" into { name, email }. */
function parseFrom(value) {
  const m = String(value).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m
    ? { name: m[1].replace(/^"|"$/g, "") || "Job Wire", email: m[2] }
    : { name: "Job Wire", email: String(value).trim() };
}

// ── Gmail SMTP ───────────────────────────────────────────────────
let smtp = null;
function getSmtp() {
  if (!gmailConfigured()) {
    throw new Error("Gmail SMTP is not configured");
  }
  if (smtp) return smtp;
  smtp = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: env.gmailUser, pass: env.gmailAppPassword },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    family: 4, // see the DNS note in server.js
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return smtp;
}

/**
 * Headers that tell mailbox providers this is wanted, automated mail.
 */
function autoMailHeaders() {
  const inbox = parseFrom(env.mailFrom || env.gmailUser).email;
  return {
    "List-Unsubscribe": `<${env.appUrl}/watches>, <mailto:${inbox}?subject=unsubscribe>`,
    "Auto-Submitted": "auto-generated",
  };
}

async function sendViaGmail({ to, subject, html, text }) {
  try {
    const info = await getSmtp().sendMail({
      from: env.mailFrom,
      to,
      replyTo: env.gmailUser,
      subject,
      text,
      html,
      headers: autoMailHeaders(),
    });
    return { ok: true, id: info.messageId, provider: "gmail(smtp)" };
  } catch (err) {
    return { ok: false, error: err.message, provider: "gmail(smtp)" };
  }
}

// ── Brevo account / credits ──────────────────────────────────────
let creditCache = { checkedAt: 0, credits: null };
let lastRouteNotice = "";

function routeNotice(message, fields = {}) {
  if (lastRouteNotice === message) return;
  lastRouteNotice = message;
  log.warn(message, fields);
}

async function fetchBrevoAccount() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(BREVO_ACCOUNT_ENDPOINT, {
      signal: ac.signal,
      headers: { "api-key": env.brevoApiKey, accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`brevo account check ${res.status}: ${body.message || body.code || "unknown"}`);
    }
    return body;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("brevo account check timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sendCredits(account) {
  const plans = Array.isArray(account?.plan) ? account.plan : [];
  const plan = plans.find((p) => p?.creditsType === "sendLimit");
  if (!plan) return null;
  const credits = Number(plan.credits);
  return Number.isFinite(credits) ? credits : null;
}

async function remainingBrevoCredits({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - creditCache.checkedAt < CREDIT_CACHE_MS) {
    return creditCache.credits;
  }

  const account = await fetchBrevoAccount();
  const credits = sendCredits(account);
  if (credits === null) {
    throw new Error("Brevo account response did not include sendLimit credits");
  }

  creditCache = { checkedAt: now, credits };
  return credits;
}

function noteBrevoAccepted() {
  if (
    Date.now() - creditCache.checkedAt < CREDIT_CACHE_MS &&
    Number.isFinite(creditCache.credits)
  ) {
    creditCache.credits = Math.max(0, creditCache.credits - 1);
  }
}

/**
 * Choose a provider BEFORE a new message is sealed into the outbox.
 *
 * A failure of the account preflight is safe to route around because no
 * message has been submitted yet. A failure AFTER sendViaBrevo begins is
 * different and is never automatically crossed over to Gmail here.
 */
export async function chooseProvider() {
  if (!env.brevoApiKey) return "gmail";
  if (!gmailConfigured()) return "brevo";

  try {
    const credits = await remainingBrevoCredits();
    if (credits > 0) {
      lastRouteNotice = "";
      return "brevo";
    }
    routeNotice("Brevo has no send credits — routing new mail through Gmail", { credits });
    return "gmail";
  } catch (err) {
    routeNotice("Brevo availability check failed — routing new mail through Gmail", {
      message: err.message,
    });
    return "gmail";
  }
}

// ── Brevo HTTP ───────────────────────────────────────────────────
/**
 * @param idempotencyKey  Brevo deduplicates transactional sends by this
 *   header, so the SAME key on a retry means the message is not sent
 *   twice even when our first attempt succeeded and we never learned it.
 */
async function sendViaBrevo({ to, subject, html, text, idempotencyKey }) {
  if (!env.brevoApiKey) {
    return { ok: false, error: "Brevo is not configured", provider: "brevo(http)" };
  }

  const from = parseFrom(env.mailFrom || env.gmailUser);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "api-key": env.brevoApiKey,
        "content-type": "application/json",
        accept: "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        sender: from,
        to: [{ email: to }],
        replyTo: { email: from.email },
        subject,
        htmlContent: html,
        textContent: text,
        headers: autoMailHeaders(),
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: `brevo ${res.status}: ${body.message || body.code || "unknown"}`,
        provider: "brevo(http)",
      };
    }

    noteBrevoAccepted();
    return { ok: true, id: body.messageId, provider: "brevo(http)" };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "brevo request timed out" : err.message,
      provider: "brevo(http)",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one message. An alert worker passes a pinned provider. System mail
 * (verification/reset) has no durable batch and chooses at send time.
 */
export async function sendMail({ to, subject, html, text, idempotencyKey, provider }) {
  const cleanSubject = String(subject).replace(/[\r\n]+/g, " ").slice(0, 200);
  const started = Date.now();
  const chosen = provider || await chooseProvider();

  const result = chosen === "brevo"
    ? await sendViaBrevo({ to, subject: cleanSubject, html, text, idempotencyKey })
    : await sendViaGmail({ to, subject: cleanSubject, html, text });

  if (result.ok) {
    log.info("mail sent", {
      to,
      via: result.provider,
      ms: Date.now() - started,
      id: result.id,
    });
  } else {
    log.error("mail failed", {
      to,
      via: result.provider || chosen,
      message: result.error,
    });
  }
  return result;
}

/**
 * Prove every configured credential at boot. One broken optional provider
 * does not make the whole mail system unavailable if the other verifies.
 */
export async function verifyTransport() {
  const errors = [];
  let verified = 0;

  if (env.brevoApiKey) {
    try {
      const account = await fetchBrevoAccount();
      const credits = sendCredits(account);
      creditCache = { checkedAt: Date.now(), credits };
      verified++;
    } catch (err) {
      errors.push(`Brevo: ${err.message}`);
    }
  }

  if (gmailConfigured()) {
    try {
      await getSmtp().verify();
      verified++;
    } catch (err) {
      errors.push(`Gmail: ${err.message}`);
    }
  }

  if (!verified) {
    throw new Error(errors.join("; ") || "no mail provider configured");
  }

  if (errors.length) {
    log.warn("one mail provider failed verification; another remains available", {
      message: errors.join("; "),
    });
  }
}
