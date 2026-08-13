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
  const clean = typeof submitted === "string" ? submitted.replace(/\D/g, "") : "";

  if (!user?.otpHash || !user?.otpExpiresAt) {
    return { result: OTP_RESULT.NONE, patch: null };
  }
  if ((user.otpAttempts ?? 0) >= MAX_ATTEMPTS) {
    return { result: OTP_RESULT.LOCKED, patch: clearOtp() };
  }
  if (Date.now() > new Date(user.otpExpiresAt).getTime()) {
    return { result: OTP_RESULT.EXPIRED, patch: clearOtp() };
  }
  if (clean.length !== DIGITS) {
    return { result: OTP_RESULT.WRONG, patch: { $inc: { otpAttempts: 1 } } };
  }

  const ok = await bcrypt.compare(clean, user.otpHash);
  if (!ok) {
    const attempts = (user.otpAttempts ?? 0) + 1;
    return {
      result: attempts >= MAX_ATTEMPTS ? OTP_RESULT.LOCKED : OTP_RESULT.WRONG,
      patch: attempts >= MAX_ATTEMPTS ? clearOtp() : { $inc: { otpAttempts: 1 } },
    };
  }

  return {
    result: OTP_RESULT.OK,
    patch: {
      $set: { verified: true, verifiedAt: new Date() },
      $unset: { otpHash: "", otpExpiresAt: "", otpAttempts: "" },
    },
  };
}

function clearOtp() {
  return { $unset: { otpHash: "", otpExpiresAt: "", otpAttempts: "" } };
}

export const otpConfig = { DIGITS, TTL_MS, MAX_ATTEMPTS };
