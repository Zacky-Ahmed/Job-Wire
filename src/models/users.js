// users.js
//
// { email, passHash, verified, otpHash, otpExpiresAt, otpAttempts, createdAt }

import { collections } from "../config/db.js";

export function findByEmail(email) {
  return collections.users().findOne({ email }); // email already sanitised by caller
}

export function findById(id) {
  return collections.users().findOne({ _id: id });
}

export async function create({ email, passHash, otpHash, otpExpiresAt }) {
  const doc = {
    email,
    passHash,
    verified: false,
    otpHash,
    otpExpiresAt,
    otpAttempts: 0,
    createdAt: new Date(),
  };
  const { insertedId } = await collections.users().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export function applyPatch(id, patch) {
  return collections.users().updateOne({ _id: id }, patch);
}

export function setOtp(id, { otpHash, otpExpiresAt }) {
  return collections.users().updateOne(
    { _id: id },
    { $set: { otpHash, otpExpiresAt, otpAttempts: 0 } }
  );
}

/** Attach a pending password-reset code, replacing any earlier one. */
export function setReset(id, { resetHash, resetExpiresAt }) {
  return collections.users().updateOne(
    { _id: id },
    { $set: { resetHash, resetExpiresAt, resetAttempts: 0 } }
  );
}

/**
 * Set a new password and retire the reset code in one write.
 *
 * passwordChangedAt is recorded so a session issued before the change can
 * be told apart from one issued after — the hook a "sign out everywhere"
 * would need, and a cheap thing to write now rather than backfill later.
 */
export function setPassword(id, passHash) {
  return collections.users().updateOne(
    { _id: id },
    {
      $set: { passHash, passwordChangedAt: new Date() },
      $unset: { resetHash: "", resetExpiresAt: "", resetAttempts: "" },
    }
  );
}
