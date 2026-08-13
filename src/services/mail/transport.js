// transport.js
//
// The ONLY file that knows which email provider is in use. When the
// Gmail 500/day cap or the spam-folder problem bites, swap this file
// for Resend or Brevo and nothing else in the app changes.

import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

let transport = null;

export function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: env.gmailUser, pass: env.gmailAppPassword },
    pool: true,        // reuse the connection across sends
    maxConnections: 2, // Gmail is unhappy with more
    maxMessages: 100,

    // Force IPv4. smtp.gmail.com resolves to both A and AAAA records, and
    // on a network without IPv6 routing Node happily picks the AAAA and
    // dies with ENETUNREACH — which looked like "Gmail is down" rather
    // than "we chose an address this machine cannot reach".
    family: 4,

    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transport;
}

/**
 * Send one message. `to` is always a single verified address — never
 * accept a recipient list from user input.
 */
export async function sendMail({ to, subject, html, text }) {
  const t = getTransport();
  const started = Date.now();
  try {
    const info = await t.sendMail({
      from: env.mailFrom,
      to,
      // Strip CR/LF: a newline in a subject lets an attacker inject
      // extra headers (Bcc:) into the message.
      subject: String(subject).replace(/[\r\n]+/g, " ").slice(0, 200),
      text,
      html,
    });
    log.info("mail sent", { to, ms: Date.now() - started, id: info.messageId });
    return { ok: true, id: info.messageId };
  } catch (err) {
    log.error("mail failed", { to, message: err.message });
    return { ok: false, error: err.message };
  }
}

export async function verifyTransport() {
  await getTransport().verify();
}
