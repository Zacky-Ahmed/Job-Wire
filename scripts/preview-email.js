// preview-email.js
//
// Renders both emails to ./email-preview/ so you can open them in a
// browser. Nothing is sent — it calls the builders directly.
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
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, msg.html);
  console.log(`  ${name.padEnd(13)} "${msg.subject}"`);
  console.log(`  ${" ".repeat(13)} ${file}\n`);
}

// The mistakes that stay invisible until a real client renders them.
const ok = (c, m) => console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
const v = messages[0][1].html;
const all = messages.map(([, m]) => m);

console.log("  checks");
ok(/letter-spacing:14px;text-indent:14px/.test(v),
   "letter-spacing compensated by text-indent (else the code sits left of centre)");
ok(/display:none;max-height:0/.test(v),
   "inbox preview text present (Gmail shows it beside the subject)");
ok(all.every((m) => !/<style/i.test(m.html)),
   "no <style> block — several clients strip it");
ok(all.every((m) => /role="presentation"/.test(m.html)),
   "table layout, not flexbox or grid");
ok(all.every((m) => !/\sclass=/.test(m.html)),
   "inline styles only, no class attributes");
ok(all.every((m) => m.text && m.text.length > 20),
   "plain-text alternative present");
ok(all.every((m) => /color-scheme/.test(m.html)),
   "color-scheme declared so dark-mode clients do not invert badly");
ok(all.every((m) => !/[\r\n]/.test(m.subject)),
   "no newlines in subject (header injection)");
console.log("");
