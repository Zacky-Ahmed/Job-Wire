// preview-email.js
//
// Renders both emails to ./email-preview/ so you can open them in a
// browser. Nothing is sent — it calls the builders directly.
//
// The checks below are deliberately about DELIVERABILITY, not looks.
// These emails leave a personal Gmail account, which is the weakest
// possible sending reputation, so anything that reads as marketing is
// what pushes them into spam or the Promotions tab.
//
// Run:  npm run preview-email

import fs from "fs";
import path from "path";
import { buildVerification, buildAlert } from "../src/services/mail/send.js";

const messages = [
  ["verification", buildVerification({ code: "483920" })],
  ["alert", buildAlert({
    label: "Interns in Sri Lanka",
    jobs: [
      { title: "Full Stack Developer Internship", company: "Niyamu",
        location: "Sri Lanka (Remote)",
        url: "https://www.linkedin.com/jobs/view/4452903165/" },
      { title: "Finance Intern (AP)", company: "NTG Shared Service Centre",
        location: "Colombo, Western Province",
        url: "https://www.linkedin.com/jobs/view/4453650078/" },
    ],
  })],
];

const dir = path.join(process.cwd(), "email-preview");
fs.mkdirSync(dir, { recursive: true });

console.log("");
for (const [name, msg] of messages) {
  fs.writeFileSync(path.join(dir, `${name}.html`), msg.html);
  console.log(`  ${name.padEnd(13)} "${msg.subject}"`);
  console.log(`  ${" ".repeat(13)} ${path.join(dir, name + ".html")}\n`);
}

const ok = (c, m) => console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
const all = messages.map(([, m]) => m);
const every = (fn) => all.every((m) => fn(m));
const v = messages[0][1];

console.log("  rendering");
// If letter-spacing is used, it must be cancelled by an equal text-indent,
// or the trailing gap after the last glyph shifts "centred" text left.
const ls = v.html.match(/letter-spacing:(\d+)px/);
const ti = v.html.match(/text-indent:(\d+)px/);
ok(!ls || (ti && ls[1] === ti[1]), "letter-spacing is cancelled by an equal text-indent");
ok(every((m) => !/display:\s*(flex|grid)/i.test(m.html)),
   "no flexbox or grid — Outlook ignores both");
ok(every((m) => !/<style/i.test(m.html)), "no <style> block — several clients strip it");
ok(every((m) => !/\sclass=/.test(m.html)), "inline styles only");
ok(every((m) => /color-scheme/.test(m.html)), "color-scheme set so dark mode does not invert badly");

console.log("\n  deliverability");
ok(every((m) => !/<img/i.test(m.html)), "no images — image-heavy mail scores as marketing");
ok(every((m) => !/background(-color)?:\s*#(?!fff|ffffff)/i.test(m.html)),
   "no coloured CTA buttons — the classic newsletter tell");
ok(every((m) => !/unsubscribe|you are receiving this because/i.test(m.html)),
   "no bulk-mail footer phrases");
ok(every((m) => m.text && m.text.length > 60),
   "real text/plain alternative (a stub is heavily penalised)");
ok(every((m) => m.subject.length <= 60), "subject under 60 chars");
// Case-sensitive for the SHOUTING check — with /i, [A-Z]{5,} matches any
// five letters and every normal word fails it.
ok(every((m) => !/[A-Z]{5,}/.test(m.subject)), "subject has no SHOUTING");
ok(every((m) => !/[!$]|\bfree\b|\burgent\b|\bwinner\b/i.test(m.subject)),
   "subject has no exclamation marks or spam words");
ok(every((m) => !/bit\.ly|tinyurl|goo\.gl/i.test(m.html)),
   "no link shorteners — links go straight to linkedin.com");
ok(every((m) => !/[\r\n]/.test(m.subject)), "no newlines in subject (header injection)");

console.log("\n  the real fix is not in this file:");
console.log("  a personal Gmail sending to strangers will always be borderline.");
console.log("  Own domain + Resend/Brevo with SPF, DKIM and DMARC is what");
console.log("  actually moves these out of spam. See README.\n");
