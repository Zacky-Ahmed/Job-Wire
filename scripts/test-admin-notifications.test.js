import test from "node:test";
import assert from "node:assert/strict";
import { buildAdminNotification, shouldNotifyManualWatch } from "../src/services/mail/adminNotificationTemplates.js";

test("manual watch alerts exclude administrators regardless of email case", () => {
  assert.equal(shouldNotifyManualWatch(" ZACKY@example.com ", ["zacky@example.com"]), false);
  assert.equal(shouldNotifyManualWatch("reader@example.com", ["zacky@example.com"]), true);
  assert.equal(shouldNotifyManualWatch("", ["zacky@example.com"]), false);
});

test("verified-user email is plain and has admin link", () => {
  const message = buildAdminNotification({
    kind: "verified_user", email: "reader@example.com",
    createdAt: new Date("2026-10-14T04:00:00Z"),
  }, "https://jobwire.me/");
  assert.match(message.subject, /verified user/);
  assert.match(message.text, /reader@example.com/);
  assert.match(message.text, /2026-10-14T04:00:00.000Z/);
  assert.match(message.text, /https:\/\/jobwire.me\/admin/);
});

test("watch notification contains details and escapes HTML", () => {
  const message = buildAdminNotification({
    kind: "manual_watch", email: "user@example.com",
    label: "<img src=x>", keywords: ["React", "Node.js"],
    location: "Sri Lanka", everyMinutes: 10,
    createdAt: new Date("2026-10-14T04:00:00Z"),
  }, "https://jobwire.me");
  assert.match(message.text, /React, Node.js/);
  assert.match(message.text, /every 10 minutes/);
  assert.doesNotMatch(message.html, /<img src=x>/);
  assert.match(message.html, /&lt;img src=x&gt;/);
});
