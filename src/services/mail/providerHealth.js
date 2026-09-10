// providerHealth.js
//
// Whether it is worth calling the mail provider at all right now.
//
// The retry model used to have one answer to every failure: try again on
// the next poller tick. That is right for a timeout and wrong for
// everything else. A wrong password produced 43 attempts in one evening
// for the same handful of jobs — each one a real network call, each one
// failing identically, each one writing a row — because "failed" carried
// no information about whether trying again could possibly help.
//
// Three states, because three things happen:
//
//   READY         nothing is known to be wrong.
//   PAUSED_CONFIG the credentials or the sender are rejected. No amount
//                 of waiting fixes this; a person has to change
//                 something. Stop calling until they do.
//   RATE_LIMITED  the provider is refusing for volume. Waiting is
//                 exactly the fix, so wait, and back off.
//
// Kept in memory rather than in Mongo on purpose. It is a statement
// about THIS process's last few attempts, and a restart is precisely the
// event after which it should be re-tested — somebody restarting the app
// after fixing a credential should not have to clear a database row too.

import { log } from "../../utils/logger.js";

export const READY = "READY";
export const PAUSED_CONFIG = "PAUSED_CONFIG";
export const RATE_LIMITED = "RATE_LIMITED";

/* How long a rate-limit pause lasts before the provider is tried again.
   Short, because being wrong in this direction only costs a delay, and
   429s are usually about a burst rather than the day. */
const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

let state = READY;
let reason = null;
let until = null;

/** Provider errors that a retry cannot fix, whoever sends it. */
export function isConfigFailure(error = "") {
  const e = String(error).toLowerCase();
  return (
    e.includes("invalid login") ||
    e.includes("username and password not accepted") ||
    e.includes("535") ||                       // SMTP auth rejected
    e.includes("bad credentials") ||
    e.includes("unauthorized") ||
    e.includes("brevo 401") ||
    e.includes("brevo 403") ||
    e.includes("sender not valid") ||
    e.includes("sender is not valid") ||
    e.includes("not verified")
  );
}

/** Provider errors that mean "too much, too fast". */
export function isRateLimit(error = "") {
  const e = String(error).toLowerCase();
  return (
    e.includes("brevo 429") ||
    e.includes("too many requests") ||
    e.includes("rate limit") ||
    e.includes("451 ") ||                      // SMTP: try again later
    e.includes("421 ")                         // SMTP: service not available
  );
}

export function noteFailure(error) {
  if (isConfigFailure(error)) {
    if (state !== PAUSED_CONFIG) {
      log.error("mail configuration is rejected — pausing delivery until it is fixed", {
        error: String(error).slice(0, 200),
      });
    }
    state = PAUSED_CONFIG;
    reason = String(error).slice(0, 200);
    until = null;                              // only a person clears this
    return state;
  }
  if (isRateLimit(error)) {
    state = RATE_LIMITED;
    reason = String(error).slice(0, 200);
    until = new Date(Date.now() + RATE_LIMIT_PAUSE_MS);
    log.warn("mail provider is rate limiting — pausing briefly", { until, error: reason });
    return state;
  }
  /* Anything else is an ordinary failure: a timeout, a refused
     recipient, a blip. The individual message backs off; the provider is
     not accused of being broken on that evidence. */
  return state;
}

export function noteSuccess() {
  if (state !== READY) log.info("mail provider is answering again", { was: state });
  state = READY;
  reason = null;
  until = null;
}

/**
 * May the worker call the provider right now?
 *
 * PAUSED_CONFIG never expires on a timer. That is the point: a
 * credential does not fix itself, and re-testing it every five minutes
 * is how the 43 attempts happened.
 */
export function canSend(now = new Date()) {
  if (state === READY) return { ok: true, state };
  if (state === PAUSED_CONFIG) return { ok: false, state, reason };
  if (until && now >= until) {
    log.info("rate-limit pause is over — trying the provider again");
    state = READY;
    reason = null;
    until = null;
    return { ok: true, state };
  }
  return { ok: false, state, reason, until };
}

export function health() {
  return { state, reason, until };
}

/** For tests, and for a future admin control that says "try again now". */
export function reset() {
  state = READY;
  reason = null;
  until = null;
}
