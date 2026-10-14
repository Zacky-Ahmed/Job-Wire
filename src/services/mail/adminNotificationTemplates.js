// adminNotificationTemplates.js
//
// Pure formatting and policy functions. These emails contain only the
// action that already succeeded; never passwords, OTP codes or session data.

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

export function shouldNotifyManualWatch(userEmail, adminEmails) {
  const email = String(userEmail || "").trim().toLowerCase();
  return !!email && !adminEmails.some((admin) => admin.toLowerCase() === email);
}

export function buildAdminNotification(event, appUrl) {
  const when = new Date(event.createdAt).toISOString();
  const adminLink = String(appUrl || "").replace(/\/+$/, "") + "/admin";
  const email = String(event.email || "");
  let subject;
  let detailLines;

  if (event.kind === "verified_user") {
    subject = "Job Wire: new verified user";
    detailLines = [
      "A user has verified their email address.",
      "Email: " + email,
    ];
  } else if (event.kind === "manual_watch") {
    subject = "Job Wire: new watch created";
    detailLines = [
      "A user has created a watch.",
      "User: " + email,
      "Watch: " + String(event.label || ""),
      "Keywords: " + (Array.isArray(event.keywords) ? event.keywords.join(", ") : ""),
      "Country: " + String(event.location || ""),
      "Interval: every " + Number(event.everyMinutes) + " minutes",
    ];
  } else {
    throw new Error("Unknown admin notification kind");
  }

  const lines = [...detailLines, "Time: " + when + " (UTC)", "", "Admin dashboard: " + adminLink];
  const text = lines.join("\n");
  const html = "<!doctype html><html lang=\"en\"><body style=\"font-family:Arial,sans-serif;line-height:1.5;color:#202124\">" +
    "<h2 style=\"font-size:18px\">" + escapeHtml(subject) + "</h2>" +
    detailLines.map((line) => "<p style=\"margin:0 0 8px\">" + escapeHtml(line) + "</p>").join("") +
    "<p style=\"margin:12px 0\">Time: " + escapeHtml(when) + " (UTC)</p>" +
    "<p><a href=\"" + escapeHtml(adminLink) + "\">Open Job Wire admin</a></p>" +
    "</body></html>";

  return { subject, text, html };
}
