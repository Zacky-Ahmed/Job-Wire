// logger.js
//
// Structured logs. Every sweep logs queryId, fetched, new, and duration —
// that log line is how you measure real lead time later.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// Render keeps logs for days and they are readable by anyone with
// dashboard access. A connection string logged once during debugging
// is a credential leak that outlives the debugging session.
// Deliberately does NOT contain bare "key" or "auth": those match
// "keywords" and "author", and over-redacting makes logs useless, which
// leads to redaction being switched off entirely.
const SECRET_KEYS = /password|passwd|secret|token|credential|cookie|authorization|apikey|api_key|uri$/i;
function redact(key, value) {
  if (SECRET_KEYS.test(key)) return "[redacted]";
  if (typeof value !== "string") return value;
  // Strip the password out of any connection string that slips through.
  return value.replace(/(mongodb(\+srv)?:\/\/[^:@\s]+:)[^@\s]+@/gi, "$1[redacted]@");
}

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const parts = fields
    ? Object.entries(fields)
        .map(([k, v]) => {
          const s = redact(k, v);
          return `${k}=${typeof s === "string" && s.includes(" ") ? JSON.stringify(s) : s}`;
        })
        .join(" ")
    : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${parts ? " " + parts : ""}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
};
