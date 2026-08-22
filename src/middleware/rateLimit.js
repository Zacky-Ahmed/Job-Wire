// rateLimit.js
//
// A 6-digit code is one million combinations. A script tries all of them
// in minutes. The per-account attempt counter in otp.js stops one account
// being ground down; these stop one IP grinding down many accounts.
//
// Requires app.set("trust proxy", 1) in server.js, or every request looks
// like it came from Render's proxy and these limits protect nobody.

import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const html = (msg) => (req, res) =>
  res.status(429).type("text/html").send(`<div class="msg err">${msg}</div>`);

/**
 * Loopback traffic is exempt OUTSIDE production.
 *
 * These limits are deliberately tight — four reset requests an hour — and
 * that is right for the internet and wrong for the machine building the
 * feature. Without this, developing or testing anything auth-shaped means
 * locking yourself out after four attempts, and the end-to-end suite
 * fails on a control that is working perfectly. That is a test that
 * teaches you to ignore it.
 *
 * Production is NODE_ENV=production and is never exempt, whatever the
 * address. The trade is that a misconfigured limit will not show up
 * locally, so the limits themselves are asserted against a deployed
 * instance, not this one.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const skip = (req) => !env.isProd && LOOPBACK.has(req.ip);

/** Account creation: slow enough that bulk signup is not worth it. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many accounts from this address. Try again in an hour."),
});

/** Password guessing. */
export const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true, // only failures count toward the limit
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many sign-in attempts. Wait 15 minutes."),
});

/** OTP submission — the brute-force target. */
export const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many attempts. Request a new code in 15 minutes."),
});

/** Resend: also protects the Gmail 500/day budget from being burned. */
export const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many codes requested. Try again in an hour."),
});

/**
 * Asking for a reset code. Tighter than resend, because this endpoint
 * will send mail to an address the requester does not have to own — the
 * cost of abuse lands on whoever's inbox it is.
 */
export const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 4,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many reset requests. Try again in an hour."),
});

/** Submitting a reset code. Mirrors verifyLimiter. */
export const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Too many attempts. Request a new code in 15 minutes."),
});

/** Everything else — a ceiling, not a real defence. */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  handler: html("Slow down."),
});
