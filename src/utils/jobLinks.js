// Safe, stable links from emailed outbox job snapshots to the site.
// A URL never embeds an email address, watch label, or application URL.

/** Only HTTP(S) application links can be offered to the browser. */
export function safeApplyUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** An outbox ObjectId identifies the durable job copy used for the email. */
export function jobDetailsUrl(outboxId, appUrl) {
  const id = String(outboxId ?? "");
  if (!/^[\da-f]{24}$/i.test(id)) return null;
  try {
    const base = new URL(String(appUrl ?? ""));
    if (!["http:", "https:"].includes(base.protocol)) return null;
    if (base.username || base.password) return null;
    return base.origin + "/job/" + id.toLowerCase();
  } catch {
    return null;
  }
}
