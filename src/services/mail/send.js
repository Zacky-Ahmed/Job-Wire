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
import { getSource } from "../sources/index.js";
import { env } from "../../config/env.js";

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

export function buildPasswordReset({ code }) {
  // Deliberately a CODE, not a link. A reset link in a message that is
  // already fighting for the inbox is the thing spam filters distrust
  // most, and this address sends through a relay it cannot prove it owns.
  // Six digits the reader retypes needs no clickable URL at all.
  const inner = `
    <p style="margin:0 0 16px;">Use this code to set a new Job Wire password:</p>
    <p style="margin:0 0 16px;font-size:30px;font-weight:bold;letter-spacing:6px;
      text-indent:6px;font-family:Menlo,Consolas,monospace;">${esc(code)}</p>
    <p style="margin:0 0 16px;">It expires in 10 minutes.</p>
    <p style="margin:0;color:${MUTED};font-size:13px;">
      If you didn't ask to reset your password, ignore this email — nothing
      has changed, and your current password still works.</p>`;

  return {
    subject: `Your Job Wire password reset code is ${code}`,
    text:
      `Use this code to set a new Job Wire password:

${code}

` +
      `It expires in 10 minutes.

` +
      `If you didn't ask to reset your password, ignore this email — nothing ` +
      `has changed, and your current password still works.`,
    html: SHELL(inner, `Your reset code is ${code}. It expires in 10 minutes.`),
  };
}

/* The alert is a DISPATCH, not a newsletter.
 *
 * Everything this product claims rests on one number — how old the
 * posting is — and the old template never printed it. It said "postings
 * like these often stop taking applications within the hour" to every
 * reader about every job, which is an unverifiable claim about a job we
 * know the actual age of. Worse, it said it about local-board postings
 * that carry a date and no time, where it is simply not true.
 *
 * So the age leads every row, in a mono column, the way the wire does.
 * The reader can see at a glance whether this is worth stopping for.
 * That is the whole product in one column of text.
 *
 * The restraint elsewhere is deliberate and documented at the top of this
 * file: no images, no coloured buttons, no bulk-mail footer. Those are
 * deliverability decisions, not a lack of ideas — the interest has to
 * come from what the email SAYS, because anything decorative costs
 * inbox placement this account cannot afford.
 */
export function buildAlert({ label, jobs }) {
  const n = jobs.length;
  const MANAGE = `${env.appUrl.replace(/\/+$/, "")}/watches`;

  const sourceName = (jobId) =>
    getSource(String(jobId).split(":")[0])?.label || "the job board";

  // Minutes since posting, when the board tells us to the minute.
  // Day-precision boards resolve everything to midnight, so an age from
  // them would read as "14h old" for something posted this morning —
  // worse than saying nothing.
  const minutesOld = (j) => {
    const src = getSource(String(j.jobId).split(":")[0]);
    if (!src || src.timePrecision !== "minute" || !j.postedAt) return null;
    return Math.max(0, Math.round((Date.now() - new Date(j.postedAt)) / 60000));
  };

  const ageText = (j) => {
    const m = minutesOld(j);
    if (m === null) return j.postedText || "today";
    if (m < 60) return `${m}m old`;
    return `${Math.round(m / 60)}h old`;
  };

  const freshest = jobs
    .map(minutesOld)
    .filter((m) => m !== null)
    .sort((a, b) => a - b)[0];

  const rows = jobs
    .map((j) => `
    <tr>
      <td style="padding:13px 12px 13px 0;vertical-align:top;white-space:nowrap;
        font-family:Menlo,Consolas,monospace;font-size:12px;color:${MUTED};
        border-top:1px solid ${LINE};">${esc(ageText(j))}</td>
      <td style="padding:13px 0;vertical-align:top;border-top:1px solid ${LINE};">
        <div style="font-weight:600;">${esc(j.title)}</div>
        <div style="color:${MUTED};font-size:14px;margin:3px 0 6px;">
          ${esc(j.company)}${j.location ? " &middot; " + esc(j.location) : ""}${j.openings > 1 ? " &middot; " + j.openings + " openings" : ""}</div>
        <a href="${esc(j.url)}" style="color:${LINK};font-size:14px;">Open on ${esc(sourceName(j.jobId))}</a>
      </td>
    </tr>`)
    .join("");

  const lead = n > 1
    ? `${n} roles matched &ldquo;${esc(label)}&rdquo;.`
    : `A role matched &ldquo;${esc(label)}&rdquo;.`;

  const inner = `
    <p style="margin:0 0 3px;">${lead}</p>
    <p style="margin:0 0 10px;color:${MUTED};font-size:13px;">
      ${freshest === undefined
        ? "Ages are shown where the board publishes them."
        : `The freshest went up ${freshest} minute${freshest === 1 ? "" : "s"} ago.`}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
      style="width:100%;border-collapse:collapse;">${rows}</table>
    <div style="border-top:1px solid ${LINE};margin-top:14px;padding-top:12px;
      color:${MUTED};font-size:12px;">
      You set up this watch &mdash;
      <a href="${esc(MANAGE)}" style="color:${LINK};">pause or delete it</a>.
    </div>`;

  /* The subject carries the job, not a count. "1 new role for Intern"
     is the same eleven characters every time and tells a lock screen
     nothing; the title and the age are what decide whether it is worth
     opening now or later. */
  const subject = n === 1
    ? `${jobs[0].title} — ${ageText(jobs[0])}`
    : `${n} roles for "${label}" — freshest ${ageText(
        jobs.slice().sort((a, b) => (minutesOld(a) ?? 1e9) - (minutesOld(b) ?? 1e9))[0]
      )}`;

  return {
    subject: subject.slice(0, 120),
    text:
      `${n > 1 ? n + " roles" : "A role"} matched your watch "${label}".\n\n` +
      jobs
        .map((j) =>
          `[${ageText(j)}] ${j.title}\n` +
          `${j.company}${j.location ? " · " + j.location : ""}${j.openings > 1 ? " · " + j.openings + " openings" : ""}\n${j.url}`)
        .join("\n\n") +
      `\n\nYou set up this watch. Pause or delete it: ${MANAGE}`,
    html: SHELL(inner, jobs.map((j) => `${ageText(j)} · ${j.title}`).join(", ")),
  };
}

export function sendVerification({ to, code }) {
  return sendMail({ to, ...buildVerification({ code }) });
}

export function sendAlert({ to, label, jobs }) {
  return sendMail({ to, ...buildAlert({ label, jobs }) });
}

export function sendPasswordReset({ to, code }) {
  return sendMail({ to, ...buildPasswordReset({ code }) });
}
