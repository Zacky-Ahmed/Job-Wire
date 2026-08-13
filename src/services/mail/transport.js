// transport.js
//
// The ONLY file that knows which email provider is in use.
//
// Two backends, chosen by which env vars are present:
//
//   BREVO_API_KEY set  ->  Brevo HTTP API over port 443
//   otherwise          ->  Gmail SMTP over port 465
//
// Why both: Gmail SMTP works fine from a laptop, and fails completely on
// Railway. Every send from the deployed app died with either
// ENETUNREACH on Google's IPv6 or a plain connection timeout on IPv4 —
// the signature of blocked outbound SMTP ports, which most PaaS hosts
// enforce to stop spam abuse. Forcing IPv4 DNS ordering did not help,
// because the port itself is unreachable.
//
// HTTPS is never blocked, so an HTTP email API sidesteps the problem
// entirely. It also improves inbox placement: a real sending domain with
// SPF/DKIM beats a personal Gmail account relaying automated mail.

import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export function providerName() {
  return env.brevoApiKey ? "brevo(http)" : "gmail(smtp)";
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

// ── Brevo HTTP ───────────────────────────────────────────────────
async function sendViaBrevo({ to, subject, html, text }) {
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
      },
      body: JSON.stringify({
        sender: from,
        to: [{ email: to }],
        replyTo: { email: from.email },
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Brevo returns a useful code, e.g. sender not verified.
      return { ok: false, error: `brevo ${res.status}: ${body.message || body.code || "unknown"}` };
    }
    return { ok: true, id: body.messageId };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "brevo request timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one message. `to` is always a single verified address — never
 * accept a recipient list from user input.
 */
export async function sendMail({ to, subject, html, text }) {
  // Strip CR/LF: a newline in a subject lets an attacker inject extra
  // headers (Bcc:) into the message.
  const cleanSubject = String(subject).replace(/[\r\n]+/g, " ").slice(0, 200);
  const started = Date.now();

  const result = env.brevoApiKey
    ? await sendViaBrevo({ to, subject: cleanSubject, html, text })
    : await getSmtp()
        .sendMail({
          from: env.mailFrom,
          to,
          replyTo: env.gmailUser,
          subject: cleanSubject,
          text,
          html,
          headers: { "Auto-Submitted": "auto-generated" },
        })
        .then((info) => ({ ok: true, id: info.messageId }))
        .catch((err) => ({ ok: false, error: err.message }));

  if (result.ok) {
    log.info("mail sent", { to, via: providerName(), ms: Date.now() - started, id: result.id });
  } else {
    log.error("mail failed", { to, via: providerName(), message: result.error });
  }
  return result;
}

/** Proves credentials at boot so a misconfiguration is loud, not silent. */
export async function verifyTransport() {
  if (env.brevoApiKey) {
    const res = await fetch("https://api.brevo.com/v3/account", {
      headers: { "api-key": env.brevoApiKey, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`brevo account check failed: ${res.status}`);
    return;
  }
  await getSmtp().verify();
}
