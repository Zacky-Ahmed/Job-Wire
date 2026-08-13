// test-mail.js
//
// Proves Gmail SMTP works before any LinkedIn code exists.
// Reads credentials from .env — run:  node scripts/test-mail.js

import "dotenv/config";
import nodemailer from "nodemailer";

const { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_FROM } = process.env;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error("✗ GMAIL_USER or GMAIL_APP_PASSWORD missing from .env");
  process.exit(1);
}
// Google shows the password as 4 groups of 4; the secret is the 16 chars.
const pass = GMAIL_APP_PASSWORD.replace(/\s+/g, "");

// Catch example/placeholder values before they turn into a confusing
// "Username and Password not accepted" and an hour of debugging Gmail.
const PLACEHOLDERS = ["abcdefghijklmnop", "xxxxxxxxxxxxxxxx", "0123456789abcdef"];
if (PLACEHOLDERS.includes(pass.toLowerCase()) || /^(.)\1+$/.test(pass)) {
  console.error("✗ GMAIL_APP_PASSWORD is still a placeholder, not a real password.");
  console.error("  Generate one at https://myaccount.google.com/apppasswords");
  console.error("  and paste the 16 characters into .env");
  process.exit(1);
}
if (pass.length !== 16) {
  console.error(`✗ Expected 16 characters after removing spaces, got ${pass.length}`);
  process.exit(1);
}
if (!/^[a-z]{16}$/.test(pass)) {
  console.error("✗ Google app passwords are 16 lowercase letters — this has other characters.");
  console.error("  Did you paste your normal Gmail password by mistake?");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass },
});

console.log("→ verifying SMTP connection…");
try {
  await transport.verify();
  console.log("✓ SMTP authenticated");
} catch (err) {
  console.error("✗ SMTP failed:", err.message);
  if (/Username and Password not accepted/i.test(err.message)) {
    console.error("  → wrong app password, or 2-Step Verification is off on the account");
  }
  if (/Invalid login/i.test(err.message)) {
    console.error("  → check GMAIL_USER is the same account the app password was made on");
  }
  process.exit(1);
}

const started = Date.now();
const info = await transport.sendMail({
  from: MAIL_FROM || GMAIL_USER,
  to: GMAIL_USER, // send to yourself
  subject: "Job Wire — SMTP test",
  text: "If you are reading this, Gmail delivery works. Nothing else is built yet.",
  html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">
    <p><strong>Gmail delivery works.</strong></p>
    <p style="color:#555">Sent from the Job Wire test script. Nothing else is built yet.</p>
  </div>`,
});

console.log(`✓ Sent in ${Date.now() - started}ms`);
console.log(`  messageId: ${info.messageId}`);
console.log(`  accepted:  ${info.accepted.join(", ")}`);
console.log("\nCheck your inbox — and the spam folder. If it landed in spam,");
console.log("that is the reason to move to Resend or Brevo before real users.");
