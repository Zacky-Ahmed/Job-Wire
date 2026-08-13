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

export function validate(password) {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return "That password is too long.";
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
