// send.js
//
// DELIVERABILITY IS THE POINT OF THIS FILE, not decoration.
//
// These emails go from a personal Gmail account to strangers. That is the
// weakest possible sending reputation, so the content must not add any
// further spam signals. Concretely, we avoid what filters score against:
//
//   · no images, no tracking pixels, no remote assets
//   · no large coloured call-to-action buttons (the classic newsletter tell)
//   · no "you are receiving this because…" footer — that phrase is a bulk
//     mail marker and does nothing for a user who just asked for alerts
//   · a real text/plain alternative that says the same thing as the HTML
//     (a missing or stub plain part is heavily penalised)
//   · short subject lines with no ALL CAPS, exclamation marks or money
//   · links go straight to linkedin.com — never a shortener or redirect
//
// The verification mail is deliberately plainer than the alert mail.
// It is the first thing a new account ever receives, and if it lands in
// spam the user cannot sign up at all, so it looks as close to a personal
// message as possible.
//
// None of this beats the real fix: send from your own domain through a
// transactional provider with SPF, DKIM and DMARC set up. See README.

import { sendMail } from "./transport.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const INK = "#1a1a1a";
const MUTED = "#5f6368";
const LINE = "#dadce0";
const LINK = "#1a56db";

const SHELL = (inner, preview) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:20px;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preview)}</div>
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,
  'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:${INK};">
${inner}
</div>
</body></html>`;

export function buildVerification({ code }) {
  // Plain on purpose. A short, text-shaped message from one Gmail address
  // to another is far more likely to reach the inbox than a designed one.
  const inner = `
    <p style="margin:0 0 16px;">Here is your Job Wire verification code:</p>
    <p style="margin:0 0 16px;font-size:30px;font-weight:bold;letter-spacing:6px;
      text-indent:6px;font-family:Menlo,Consolas,monospace;">${esc(code)}</p>
    <p style="margin:0 0 16px;">It expires in 10 minutes.</p>
    <p style="margin:0;color:${MUTED};font-size:13px;">
      If you didn't try to sign in, you can ignore this email.</p>`;

  return {
    subject: `Your Job Wire code is ${code}`,
    text:
      `Here is your Job Wire verification code:\n\n${code}\n\n` +
      `It expires in 10 minutes.\n\n` +
      `If you didn't try to sign in, you can ignore this email.`,
    html: SHELL(inner, `Your code is ${code}. It expires in 10 minutes.`),
  };
}

export function buildAlert({ label, jobs }) {
  const n = jobs.length;

  // Plain links, not buttons. A row of coloured CTAs is the single
  // strongest "this is marketing" signal in an email.
  const rows = jobs
    .map(
      (j) => `
    <div style="padding:14px 0;border-top:1px solid ${LINE};">
      <div style="font-weight:600;">${esc(j.title)}</div>
      <div style="color:${MUTED};font-size:14px;margin:3px 0 8px;">
        ${esc(j.company)}${j.location ? " — " + esc(j.location) : ""}</div>
      <a href="${esc(j.url)}" style="color:${LINK};font-size:14px;">Open on LinkedIn</a>
    </div>`
    )
    .join("");

  const inner = `
    <p style="margin:0 0 4px;">
      ${n} new ${n > 1 ? "roles" : "role"} matched your watch
      &ldquo;${esc(label)}&rdquo;.</p>
    <p style="margin:0 0 8px;color:${MUTED};font-size:13px;">
      Postings like these often stop taking applications within the hour.</p>
    ${rows}
    <div style="border-top:1px solid ${LINE};margin-top:14px;padding-top:12px;
      color:${MUTED};font-size:12px;">
      Job Wire — you set up this watch. Manage it any time.
    </div>`;

  return {
    subject:
      n > 1 ? `${n} new roles for "${label}"` : `New role for "${label}"`,
    text:
      `${n} new ${n > 1 ? "roles" : "role"} matched your watch "${label}".\n\n` +
      jobs
        .map((j) => `${j.title}\n${j.company}${j.location ? " — " + j.location : ""}\n${j.url}`)
        .join("\n\n") +
      `\n\nPostings like these often stop taking applications within the hour.`,
    html: SHELL(inner, jobs.map((j) => j.title).join(", ")),
  };
}

export function sendVerification({ to, code }) {
  return sendMail({ to, ...buildVerification({ code }) });
}

export function sendAlert({ to, label, jobs }) {
  return sendMail({ to, ...buildAlert({ label, jobs }) });
}
