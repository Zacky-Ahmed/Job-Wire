// password.js
//
// bcryptjs, not bcrypt: pure JS, so no native build step on Windows dev
// machines or in Render's build container.

import bcrypt from "bcryptjs";

// 12 rounds ≈ 250ms on typical hardware. Slow enough to make offline
// cracking expensive, fast enough that sign-in feels instant.
const ROUNDS = 12;
const MIN_LENGTH = 8;
const MAX_LENGTH = 200; // bcrypt truncates at 72 bytes; reject long inputs
                        // outright rather than silently ignoring the tail

/*
 * A blocklist, not complexity rules.
 *
 * Length alone let every one of these through: password, 12345678,
 * qwertyui, iloveyou, letmein1. Per-IP rate limiting does not help here —
 * it stops one address guessing quickly, not someone trying "password"
 * once against each account in turn, which is how credential stuffing
 * actually works.
 *
 * Deliberately NOT a "must contain a symbol and a capital" rule. Those
 * push people towards Password1! — which is on every cracking list — and
 * NIST now advises against them for exactly that reason. Screening
 * against known-bad choices is the thing that measurably helps.
 */
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssword", "p@ssw0rd",
  "12345678", "123456789", "1234567890", "123123123", "111111111", "11111111",
  "qwertyui", "qwerty123", "qwertyuiop", "asdfghjk", "asdfghjkl", "zxcvbnm1",
  "iloveyou", "princess", "sunshine", "football", "baseball", "superman",
  "trustno1", "letmein1", "welcome1", "monkey12", "dragon123", "starwars",
  "abc12345", "a1b2c3d4", "computer", "internet", "whatever", "cheese1",
  "michael1", "jennifer", "jordan23", "shadow12", "master12", "hunter22",
  "batman12", "pokemon1", "samsung1", "myspace1", "liverpool", "chelsea1",
  "changeme", "secret12", "default1", "adminadmin", "administrator",
]);

/**
 * @param password  what they typed
 * @param context   optional: { email } — a password that is just the
 *                  address, or the product name, is as guessable as any
 *                  entry above and cannot be listed in advance.
 */
export function validate(password, context = {}) {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return "That password is too long.";

  const lower = password.toLowerCase();
  if (COMMON.has(lower))
    return "That is one of the most common passwords in the world. Pick another.";

  // All one character — "aaaaaaaa", "11111111" beyond the listed ones.
  // A Set rather than /^(.)\1+$/. The backreference version is correct
  // and fragile: an earlier edit of this very line wrote a raw 0x01 byte
  // instead of the escape, leaving a regex that silently matched nothing
  // and a rule that quietly did not exist. This cannot be mistyped into
  // something that still runs.
  if (new Set(password).size === 1)
    return "That is the same character repeated. Pick another.";

  if (lower.includes("jobwire"))
    return "Do not use the site's name in your password.";

  const local = String(context.email || "").split("@")[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local))
    return "Do not use your email address in your password.";

  return null; // valid
}

export async function hash(password) {
  const problem = validate(password);
  if (problem) throw new Error(problem);
  return bcrypt.hash(password, ROUNDS);
}

/**
 * Always runs a real bcrypt comparison, even when the user does not
 * exist — otherwise the response time reveals which emails are
 * registered. Pass null for storedHash in that case.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.9pJ6H5Q0kFV1J8Y8Z8Z8Z8Z8Z8Z8Z8Z";

export async function verify(password, storedHash) {
  if (typeof password !== "string" || password.length > MAX_LENGTH) {
    await bcrypt.compare("x", DUMMY_HASH).catch(() => {});
    return false;
  }
  if (!storedHash) {
    await bcrypt.compare(password, DUMMY_HASH).catch(() => {});
    return false;
  }
  return bcrypt.compare(password, storedHash);
}
