// auth.routes.js
//
// Signup creates an UNVERIFIED user. Nothing else in the app is reachable
// and no alert is ever sent until the emailed code is confirmed.

import { Router } from "express";
import { authPage } from "../utils/render.js";
import { email as cleanEmail, str, oid } from "../utils/sanitize.js";
import * as Users from "../models/users.js";
import * as pw from "../services/auth/password.js";
import * as otp from "../services/auth/otp.js";
import { sendVerification, sendPasswordReset } from "../services/mail/send.js";
import { redirectIfAuthed } from "../middleware/requireAuth.js";
import { signupLimiter, signinLimiter, verifyLimiter, resendLimiter,
  forgotLimiter, resetLimiter } from "../middleware/rateLimit.js";
import { log } from "../utils/logger.js";

export const authRoutes = Router();

const show = (res, view, extra = {}) =>
  authPage(res, `pages/${view}`, {
    title: extra.title || view,
    step: extra.step ?? 1,
    error: extra.error || null,
    notice: extra.notice || null,
    values: extra.values || {},
    email: extra.email || "",
  });

// ── signup ───────────────────────────────────────────────────────
authRoutes.get("/signup", redirectIfAuthed, (req, res) =>
  show(res, "signup", { title: "Create account" })
);

authRoutes.post("/signup", redirectIfAuthed, signupLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = str(req.body.password, { max: 200 });
    const confirm = str(req.body.confirm, { max: 200 });
    const values = { email: str(req.body.email, { max: 254 }) };

    if (!email) return show(res, "signup", { error: "Enter a valid email address.", values });
    const problem = pw.validate(password);
    if (problem) return show(res, "signup", { error: problem, values });
    if (password !== confirm)
      return show(res, "signup", { error: "The two passwords do not match.", values });

    const existing = await Users.findByEmail(email);
    if (existing) {
      // Do not confirm that the address is registered — same message either way.
      if (existing.verified)
        return show(res, "signup", {
          error: "If that address can be registered, we have sent a code. Otherwise, sign in.",
          values,
        });
      // Unverified: reissue rather than blocking them out of their own account.
      const { code, hash, expiresAt } = await otp.issue();
      await Users.setOtp(existing._id, { otpHash: hash, otpExpiresAt: expiresAt });
      await sendVerification({ to: email, code });
      req.session.pendingUserId = String(existing._id);
      return show(res, "verify", { title: "Verify", step: 2, email });
    }

    const { code, hash, expiresAt } = await otp.issue();
    const user = await Users.create({
      email,
      passHash: await pw.hash(password),
      otpHash: hash,
      otpExpiresAt: expiresAt,
    });

    const sent = await sendVerification({ to: email, code });
    if (!sent.ok)
      return show(res, "signup", { error: "We could not send the code. Try again shortly.", values });

    req.session.pendingUserId = String(user._id);
    log.info("signup", { email });
    return show(res, "verify", { title: "Verify", step: 2, email });
  } catch (err) {
    next(err);
  }
});

// ── verify ───────────────────────────────────────────────────────
authRoutes.get("/verify", async (req, res) => {
  const id = oid(req.session.pendingUserId);
  if (!id) return res.redirect("/signup");
  const user = await Users.findById(id);
  if (!user) return res.redirect("/signup");
  if (user.verified) return res.redirect("/signin");
  show(res, "verify", { title: "Verify", step: 2, email: user.email });
});

authRoutes.post("/verify", verifyLimiter, async (req, res, next) => {
  try {
    const id = oid(req.session.pendingUserId);
    if (!id) return res.redirect("/signup");
    const user = await Users.findById(id);
    if (!user) return res.redirect("/signup");

    const code = ["d1", "d2", "d3", "d4", "d5", "d6"]
      .map((k) => str(req.body[k], { max: 1 })).join("");

    const { result, patch } = await otp.check(user, code);
    if (patch) await Users.applyPatch(user._id, patch);

    if (result === otp.OTP_RESULT.OK) {
      // regenerate gives a fresh session id (prevents fixation), and save()
      // must complete BEFORE the redirect: res.redirect ends the response
      // while the store write is still in flight, so a fast client can
      // request /wire before the session exists and get bounced to /signin.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = String(user._id);
        req.session.save((err2) => {
          if (err2) return next(err2);
          log.info("verified", { email: user.email });
          res.redirect("/wire");
        });
      });
      return;
    }

    const messages = {
      wrong: "Wrong code. Check the digits and try again.",
      expired: "That code expired. Request a new one.",
      locked: "Too many attempts. Request a new code.",
      none: "No code is pending. Request a new one.",
    };
    show(res, "verify", { title: "Verify", step: 2, email: user.email, error: messages[result] });
  } catch (err) {
    next(err);
  }
});

authRoutes.post("/resend", resendLimiter, async (req, res, next) => {
  try {
    const id = oid(req.session.pendingUserId);
    if (!id) return res.redirect("/signup");
    const user = await Users.findById(id);
    if (!user || user.verified) return res.redirect("/signin");

    const { code, hash, expiresAt } = await otp.issue();
    await Users.setOtp(user._id, { otpHash: hash, otpExpiresAt: expiresAt });
    await sendVerification({ to: user.email, code });
    show(res, "verify", {
      title: "Verify", step: 2, email: user.email, notice: "A new code is on its way.",
    });
  } catch (err) {
    next(err);
  }
});

// ── signin ───────────────────────────────────────────────────────
authRoutes.get("/signin", redirectIfAuthed, (req, res) =>
  show(res, "signin", { title: "Sign in" })
);

authRoutes.post("/signin", redirectIfAuthed, signinLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = str(req.body.password, { max: 200 });
    const values = { email: str(req.body.email, { max: 254 }) };
    const user = email ? await Users.findByEmail(email) : null;

    // verify() runs a real bcrypt compare even when user is null, so the
    // response time does not reveal which addresses are registered.
    const ok = await pw.verify(password, user?.passHash);
    if (!user || !ok)
      return show(res, "signin", { error: "Email or password is incorrect.", values });

    if (!user.verified) {
      const { code, hash, expiresAt } = await otp.issue();
      await Users.setOtp(user._id, { otpHash: hash, otpExpiresAt: expiresAt });
      await sendVerification({ to: user.email, code });
      req.session.pendingUserId = String(user._id);
      return show(res, "verify", {
        title: "Verify", step: 2, email: user.email,
        notice: "Confirm your address first — we sent a new code.",
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = String(user._id);
      // save() before redirecting — see the note in /verify.
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.redirect("/wire");
      });
    });
  } catch (err) {
    next(err);
  }
});

// ── forgotten password ───────────────────────────────────────────
//
// A code, not a link, for the same reason the verification mail uses one:
// this address sends through a relay it cannot prove it owns, and a
// clickable reset URL is the single thing spam filters distrust most.
//
// The response NEVER says whether an address has an account. "No account
// with that email" turns this form into a membership oracle — paste a
// list, learn who is registered — and it helps a real user not at all,
// since someone who mistyped their address is told the same thing either
// way: check your inbox.

authRoutes.get("/forgot", redirectIfAuthed, (req, res) =>
  show(res, "forgot", { title: "Reset password" })
);

authRoutes.post("/forgot", redirectIfAuthed, forgotLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const user = email ? await Users.findByEmail(email) : null;

    if (user) {
      const { code, hash, expiresAt } = await otp.issue();
      await Users.setReset(user._id, { resetHash: hash, resetExpiresAt: expiresAt });

      // NOT awaited, and that is the point.
      //
      // Awaiting the send made this endpoint answer in ~5s for a real
      // address and ~0.7s for one with no account — measured. Identical
      // wording is worthless next to a four-second tell: paste a list,
      // time the responses, learn exactly who is registered. Handing the
      // send off makes both branches return on the same path.
      //
      // Nothing is lost by not waiting: the reader is told to check their
      // inbox either way, and a failure here must not be reported to them
      // anyway — "we could not email you" confirms the account exists.
      sendPasswordReset({ to: user.email, code }).catch((err) =>
        log.error("reset email failed to send", { email: user.email, message: err.message })
      );

      // Held in the session so the next step does not have to re-ask for
      // the address — and so the code cannot be applied to a DIFFERENT
      // account by editing a form field.
      req.session.resetUserId = String(user._id);
      log.info("password reset requested", { email: user.email });
    } else {
      // Deliberately does the same shape of work — hashing a code is the
      // expensive part of the branch above now that the mail is detached.
      await otp.issue();
      log.info("password reset requested for an unknown address");
    }

    req.session.save(() => {
      show(res, "reset", {
        title: "Reset password", step: 2,
        email: str(req.body.email, { max: 254 }),
        notice: "If that address has an account, a six-digit code is on its way. It expires in 10 minutes.",
      });
    });
  } catch (err) {
    next(err);
  }
});

authRoutes.post("/reset", resetLimiter, async (req, res, next) => {
  try {
    const id = oid(req.session.resetUserId);
    const typed = str(req.body.email, { max: 254 });
    const back = (extra) => show(res, "reset", { title: "Reset password", step: 2, email: typed, ...extra });

    // No pending request in this session. Say the code is wrong rather
    // than "no request pending", which would confirm the address instead.
    if (!id) return back({ error: "That code is not valid. Request a new one." });
    const user = await Users.findById(id);
    if (!user) return back({ error: "That code is not valid. Request a new one." });

    const code = ["d1", "d2", "d3", "d4", "d5", "d6"]
      .map((k) => str(req.body[k], { max: 1 })).join("");
    const password = str(req.body.password, { max: 200 });
    const confirm = str(req.body.password2, { max: 200 });

    // Check the passwords BEFORE spending an attempt on the code: a typo
    // in the confirm box should not burn one of five tries.
    if (password.length < 8)
      return back({ error: "Use at least 8 characters." });
    if (password !== confirm)
      return back({ error: "Those passwords do not match." });

    const { result, patch } = await otp.checkReset(user, code);
    if (patch) await Users.applyPatch(user._id, patch);

    if (result !== otp.OTP_RESULT.OK) {
      const messages = {
        wrong: "Wrong code. Check the digits and try again.",
        expired: "That code expired. Request a new one.",
        locked: "Too many attempts. Request a new code.",
        none: "That code is not valid. Request a new one.",
      };
      return back({ error: messages[result] });
    }

    await Users.setPassword(user._id, await pw.hash(password));
    log.info("password reset", { email: user.email });

    // regenerate drops the old session id along with resetUserId, so the
    // code cannot be replayed, and signs them in on a fresh one.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = String(user._id);
      req.session.save((err2) => (err2 ? next(err2) : res.redirect("/wire")));
    });
  } catch (err) {
    next(err);
  }
});

authRoutes.post("/signout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("jw.sid");
    res.redirect("/signin");
  });
});
