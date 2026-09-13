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

/**
 * Make an account verified AND usable, in one write.
 *
 * THE ONLY DEFINITION OF "VERIFIED". There were two, and they disagreed:
 * /verify promoted the staged password, and the admin's "verify by hand"
 * button set verified:true and cleared the OTP fields without touching
 * pendingPassHash. So an admin could produce an account that reported
 * VERIFIED with passHash still null and the real password stranded in
 * staging — the person could not sign in, and the admin action that was
 * supposed to rescue a locked account had quietly finished locking it.
 *
 * ONE operation, not two writes. The old shape verified the account and
 * promoted the password separately, so a process dying between them left
 * verified:true, the code consumed, and no usable password — a state
 * that should not exist and cannot be recovered from without a reset.
 *
 * $setOnInsert is not involved and passHash is set from the document's
 * OWN staged value with an aggregation pipeline, so the promotion cannot
 * use a stale copy read minutes earlier by the caller.
 */
export async function completeVerification(id) {
  const row = await collections.users().findOneAndUpdate(
    { _id: id },
    [
      {
        $set: {
          verified: true,
          verifiedAt: new Date(),
          /* Promote the staged password if there is one, and otherwise
             leave the existing hash alone. An account being verified by
             hand after its staging was already consumed must not have
             its password blanked. */
          passHash: { $ifNull: ["$pendingPassHash", "$passHash"] },
        },
      },
      { $unset: ["pendingPassHash", "otpHash", "otpExpiresAt", "otpAttempts"] },
    ],
    { returnDocument: "after", projection: { sessionVersion: 1, email: 1, passHash: 1, verified: 1 } }
  );
  return row?.value ?? row;
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
export async function setPassword(id, passHash) {
  /* RETURNS THE NEW VERSION, and the caller must use it.

     This incremented sessionVersion and returned nothing, so /reset
     stamped the session it had just created with the version from the
     user document it loaded BEFORE the write. Database said 1, session
     said 0, and requireAuth destroyed the brand-new session on the very
     next request — a successful password reset signed the person
     straight back out, every single time.

     findOneAndUpdate rather than updateOne so the number comes from the
     write itself. Reading it back afterwards would be a second round
     trip with a race in the middle, and computing it locally as
     (old + 1) is the same stale-read bug wearing a hat. */
  const row = await collections.users().findOneAndUpdate(
    { _id: id },
    {
      $set: { passHash, passwordChangedAt: new Date() },
      $inc: { sessionVersion: 1 },
      $unset: { resetHash: "", resetExpiresAt: "", resetAttempts: "" },
    },
    { returnDocument: "after", projection: { sessionVersion: 1, email: 1 } }
  );
  return row?.value ?? row;
}
