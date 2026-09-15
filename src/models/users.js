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

/**
 * Stage a password without granting it.
 *
 * An unverified account is unowned: anyone can type any address into
 * /signup. Writing passHash there meant an attacker could register a
 * victim's address with their own password, and the victim's later
 * verification blessed it. The candidate sits in pendingPassHash until
 * whoever controls the mailbox proves it with the code.
 */
export function setPendingPassword(id, pendingPassHash) {
  return collections.users().updateOne({ _id: id }, { $set: { pendingPassHash } });
}

/** Promote the staged password. Called only on a correct code. */
export function promotePendingPassword(id, pendingPassHash) {
  return collections.users().updateOne(
    { _id: id },
    { $set: { passHash: pendingPassHash, verified: true },
      $unset: { pendingPassHash: "", otpHash: "", otpExpiresAt: "", otpAttempts: "" } }
  );
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
 * Set a new password, retire the reset code, and sign out everywhere.
 *
 * passwordChangedAt was already being written, with a comment saying it
 * was "the hook a sign out everywhere would need". Nothing read it. So
 * the sequence that matters worked out badly:
 *
 *   somebody's session is stolen
 *   the owner notices and resets their password
 *   the thief's session keeps working until it expires on its own
 *
 * Changing a password is the single clearest way a person says "lock
 * this account down", and it has to mean it. sessionVersion is bumped
 * here and compared on every authenticated request, so every session
 * issued before this moment stops working — including the one making
 * this very request, which then has to sign in again. That is the
 * correct behaviour and the expected behaviour.
 *
 * A counter rather than a timestamp comparison: clocks between the app
 * and the database need not agree, and a session issued in the same
 * second as the change should not be a coin toss.
 */
export function setPassword(id, passHash) {
  return collections.users().updateOne(
    { _id: id },
    {
      $set: { passHash, passwordChangedAt: new Date() },
      $inc: { sessionVersion: 1 },
      $unset: { resetHash: "", resetExpiresAt: "", resetAttempts: "" },
    }
  );
}
