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
