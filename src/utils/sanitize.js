// sanitize.js
//
// NoSQL injection defence.
//
// Express parses JSON bodies into real objects, so a request body of
//   { "email": { "$ne": null } }
// turned into  users.findOne({ email: req.body.email })  matches the
// FIRST user in the collection and logs the attacker in as them.
//
// Every value that reaches a Mongo query must go through here first.

import { ObjectId } from "mongodb";

/** Coerce to a plain string. Objects, arrays and null become "". */
export function str(v, { max = 500 } = {}) {
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return ""; // objects/arrays/null/undefined -> never reaches Mongo as an operator
}

/** Normalised email, or "" if it isn't one. */
export function email(v) {
  const s = str(v, { max: 254 }).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) ? s : "";
}

/** Valid ObjectId or null. Never throws on user input. */
export function oid(v) {
  const s = str(v, { max: 24 });
  return ObjectId.isValid(s) ? new ObjectId(s) : null;
}

/** Bounded integer. */
export function int(v, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) {
  const n = Number(str(v, { max: 20 }));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Comma-separated keywords -> clean array. Caps count and length. */
export function keywords(v, { maxItems = 8, maxLen = 60 } = {}) {
  return str(v, { max: 600 })
    .split(",")
    .map((k) => k.trim().replace(/[^\p{L}\p{N}\s+#.&/-]/gu, ""))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((k) => k.slice(0, maxLen));
}

/**
 * Belt-and-braces: reject any body containing Mongo operators or
 * prototype-pollution keys. Mount as middleware in front of routes so a
 * single forgotten str() call is not exploitable.
 */
export function rejectOperators(req, res, next) {
  const bad = ["__proto__", "constructor", "prototype"];
  function scan(value, depth = 0) {
    if (depth > 6 || value === null || typeof value !== "object") return false;
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") || bad.includes(key)) return true;
      if (scan(value[key], depth + 1)) return true;
    }
    return false;
  }
  if (scan(req.body) || scan(req.query) || scan(req.params)) {
    return res.status(400).type("text/html").send("Bad request.");
  }
  next();
}
