// send.js
//
// sendAlert takes an ARRAY of jobs on purpose: one email per sweep,
// never one per job. Six new roles is six rows in one message, not six
// notifications — kinder to read, and the only way to stay inside
// Gmail's ~500/day ceiling.
//
// Email rendering rules that drive everything below:
//   · tables, not flexbox or grid — Outlook ignores modern layout
//   · inline styles only — <style> blocks are stripped by several clients
//   · explicit background on every cell, or dark-mode clients invert
//     text to white and leave the background white too
//   · letter-spacing must be compensated with text-indent when centring,
//     because the trailing space after the last glyph is included in the
//     measured width and shifts the text visibly left

import { sendMail } from "./transport.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CORAL = "#ff4d29";
const INK = "#16192a";
const MUTED = "#535b78";
const LINE = "#e2e6f0";
const PAPER = "#f6f7fb";

/**
 * @param inner   body HTML
 * @param preview text shown in the inbox list next to the subject —
 *                without it Gmail previews whatever markup comes first
 */
const WRAP = (inner, preview) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
  style="background:${PAPER};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
      <tr><td style="padding:16px 22px;border-bottom:1px solid ${LINE};background:#ffffff;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;
          letter-spacing:1.5px;color:${CORAL};">JOB WIRE</span>
      </td></tr>
      <tr><td style="padding:22px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;
        color:${INK};">${inner}</td></tr>
      <tr><td style="padding:14px 22px;border-top:1px solid ${LINE};background:#ffffff;
        font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8b93b0;">
        You are receiving this because you set up a watch on Job Wire.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

/** Builds the message. Separate from sending so previews and tests can
 *  render it without a mail server. */
export function buildVerification({ code }) {
  // text-indent equals letter-spacing: cancels the trailing gap after the
  // final digit, which otherwise pushes the "centred" code 7px left.
  const inner = `
    <p style="margin:0 0 6px;font-size:19px;font-weight:bold;color:${INK};">Confirm your address</p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:${MUTED};">
      Enter this code to finish setting up your account.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="background:${PAPER};border:1px solid ${LINE};
        border-radius:10px;padding:20px 12px;">
        <span style="font-family:'Courier New',Courier,monospace;font-size:34px;
          font-weight:bold;letter-spacing:14px;text-indent:14px;color:${INK};
          display:inline-block;">${esc(code)}</span>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:${MUTED};">
      It expires in <strong style="color:${INK};">10 minutes</strong>.
      If you didn't request it, you can ignore this email.</p>`;

  return {
    subject: `${code} is your Job Wire verification code`,
    text: `Your Job Wire verification code is ${code}\n\nIt expires in 10 minutes.`,
    html: WRAP(inner, `Your code is ${code} — expires in 10 minutes.`),
  };
}

export function sendVerification({ to, code }) {
  return sendMail({ to, ...buildVerification({ code }) });
}

export function buildAlert({ label, jobs }) {
  const n = jobs.length;

  const rows = jobs
    .map(
      (j) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border:1px solid ${LINE};border-radius:10px;margin-bottom:12px;">
      <tr><td style="padding:14px;background:#ffffff;">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;
          color:${INK};line-height:1.35;">${esc(j.title)}</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${MUTED};
          margin:5px 0 14px;">${esc(j.company)}${j.location ? " &middot; " + esc(j.location) : ""}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background:${CORAL};border-radius:8px;">
            <a href="${esc(j.url)}" style="display:inline-block;padding:11px 22px;
              font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;
              color:#ffffff;text-decoration:none;">Apply on LinkedIn &rarr;</a>
          </td></tr>
        </table>
      </td></tr>
    </table>`
    )
    .join("");

  const inner = `
    <p style="margin:0 0 6px;font-size:19px;font-weight:bold;color:${INK};">
      ${n} new role${n > 1 ? "s" : ""} matched</p>
    <p style="margin:0 0 18px;font-size:14px;color:${MUTED};">
      From your watch &ldquo;${esc(label)}&rdquo;.</p>
    ${rows}
    <p style="margin:16px 0 0;font-size:12px;line-height:1.55;color:#8b93b0;">
      Posts like these often stop accepting applications within the hour.
      Applying early is most of the advantage.</p>`;

  return {
    subject: `${n} new role${n > 1 ? "s" : ""} matched "${label}"`,
    text:
      `${n} new role${n > 1 ? "s" : ""} matched "${label}"\n\n` +
      jobs.map((j) => `${j.title}\n${j.company}\n${j.url}`).join("\n\n"),
    html: WRAP(inner, `${jobs.map((j) => j.title).join(", ")} — apply now`),
  };
}

export function sendAlert({ to, label, jobs }) {
  return sendMail({ to, ...buildAlert({ label, jobs }) });
}
