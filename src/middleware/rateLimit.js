// rateLimit.js
//
// A 6-digit code is one million combinations. A script tries all of them
// in minutes. The per-account attempt counter in otp.js stops one account
// being ground down; these stop one IP grinding down many accounts.
//
// Requires app.set("trust proxy", 1) in server.js, or every request looks
// like it came from Render's proxy and these limits protect nobody.

import rateLimit from "express-rate-limit";

const html = (msg) => (req, res) =>
  res.status(429).type("text/html").send(`<div class="msg err">${msg}</div>`);

/** Account creation: slow enough that bulk signup is not worth it. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: html("Too many accounts from this address. Try again in an hour."),
});

/** Password guessing. */
export const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true, // only failures count toward the limit
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: html("Too many sign-in attempts. Wait 15 minutes."),
});

/** OTP submission — the brute-force target. */
export const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: html("Too many attempts. Request a new code in 15 minutes."),
});

/** Resend: also protects the Gmail 500/day budget from being burned. */
export const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: html("Too many codes requested. Try again in an hour."),
});

/** Everything else — a ceiling, not a real defence. */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: html("Slow down."),
});
