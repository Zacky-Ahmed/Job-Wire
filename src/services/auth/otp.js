// otp.js
//
// Six digits is only a million combinations, so the code itself is weak
// by design — the protection has to come from the rules around it:
//
//   · crypto.randomInt, never Math.random (predictable from a few samples)
//   · stored bcrypt-hashed, so a database leak does not hand over live
//     codes (a SHA of 6 digits is reversed by a rainbow table instantly)
//   · 10 minute expiry
//   · 5 attempts, then the code is destroyed and a new one is required
//
// rateLimit.js covers the other axis: one IP grinding many accounts.

import crypto from "crypto";
import bcrypt from "bcryptjs";

const DIGITS = 6;
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ROUNDS = 10; // lower than passwords: verified often, low entropy anyway

/** Returns { code, hash, expiresAt } — send `code`, store the rest. */
export async function issue() {
  const code = String(crypto.randomInt(0, 10 ** DIGITS)).padStart(DIGITS, "0");
  return {
    code,
    hash: await bcrypt.hash(code, ROUNDS),
    expiresAt: new Date(Date.now() + TTL_MS),
  };
}

export const OTP_RESULT = {
  OK: "ok",
  WRONG: "wrong",
  EXPIRED: "expired",
  LOCKED: "locked",
  NONE: "none",
};

/**
 * Check a submitted code against a user document.
 * The caller persists the returned `patch` — this function does no I/O,
 * so it stays trivially testable.
 */
export async function check(user, submitted) {
  return verifyAgainst(user, submitted, SIGNUP);
}

/**
 * A password reset uses its own fields, not the signup ones.
 *
 * Sharing otpHash would mean requesting a reset silently invalidates a
 * verification code the same person is part-way through typing, and vice
 * versa — two flows quietly cancelling each other with no message either
 * time. The rules (six digits, ten minutes, five attempts, bcrypt at
 * rest) are identical; only the fields differ.
 */
export async function checkReset(user, submitted) {
  return verifyAgainst(user, submitted, RESET);
}

const SIGNUP = { hash: "otpHash", exp: "otpExpiresAt", att: "otpAttempts", verifies: true };
const RESET = { hash: "resetHash", exp: "resetExpiresAt", att: "resetAttempts", verifies: false };

async function verifyAgainst(user, submitted, f) {
  const clean = typeof submitted === "string" ? submitted.replace(/\D/g, "") : "";

  if (!user?.[f.hash] || !user?.[f.exp]) {
    return { result: OTP_RESULT.NONE, patch: null };
  }
  if ((user[f.att] ?? 0) >= MAX_ATTEMPTS) {
    return { result: OTP_RESULT.LOCKED, patch: clearCode(f) };
  }
  if (Date.now() > new Date(user[f.exp]).getTime()) {
    return { result: OTP_RESULT.EXPIRED, patch: clearCode(f) };
  }
  if (clean.length !== DIGITS) {
    return { result: OTP_RESULT.WRONG, patch: { $inc: { [f.att]: 1 } } };
  }

  const ok = await bcrypt.compare(clean, user[f.hash]);
  if (!ok) {
    const attempts = (user[f.att] ?? 0) + 1;
    return {
      result: attempts >= MAX_ATTEMPTS ? OTP_RESULT.LOCKED : OTP_RESULT.WRONG,
      patch: attempts >= MAX_ATTEMPTS ? clearCode(f) : { $inc: { [f.att]: 1 } },
    };
  }

  const patch = clearCode(f);
  // Receiving a code at the address IS proof of the address, so a reset
  // confirms an account that never finished signing up rather than
  // stranding it in a verification step it has already satisfied.
  patch.$set = { verified: true, verifiedAt: new Date() };
  return { result: OTP_RESULT.OK, patch };
}

function clearCode(f) {
  return { $unset: { [f.hash]: "", [f.exp]: "", [f.att]: "" } };
}

export const otpConfig = { DIGITS, TTL_MS, MAX_ATTEMPTS };
