// time.js
//
// Every timestamp is stored as a Date and formatted at render time —
// never store pre-formatted strings, they rot the moment they are saved.

export function rel(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

export function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function countdown(to) {
  if (!to) return "held";
  return "T-" + mmss((new Date(to).getTime() - Date.now()) / 1000);
}

export function minutesSince(ts) {
  return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
}
