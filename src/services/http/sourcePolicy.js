// sourcePolicy.js
//
// One process-wide gate covers adapters, detail calls, manual probes and redirects.
//
// In-memory state resets on restart. For a persistent, replica-shared budget use
// a separate Mongo-backed sourceTraffic document (see db.js / indexes.js).
// Multiple manual processes or frequent restarts can exceed an aggregate envelope;
// keep probes off deployment hosts.

import { env } from "../../config/env.js";

export const SOURCE_HOSTS = {
  linkedin: ["linkedin.com"], keells: ["careers.keells.com"],
  topjobs: ["topjobs.lk"], mas: ["egmh.fa.us6.oraclecloud.com"],
  itpro: ["itpro.lk"], xpress: ["xpress.jobs"], rooster: ["api.rooster.jobs"],
};

export class SourcePolicyError extends Error {
  constructor(source, reason) {
    super(`${source}: ${reason}`);
    this.name = "SourcePolicyError";
    this.code = "SOURCE_POLICY";
  }
}

/**
 * Creates a source policy gate.
 *
 * @param {object} opts
 * @param {string[]}  opts.disabled                  - source ids disabled by SOURCES_DISABLED
 * @param {boolean}   opts.linkedinAccessConfirmed    - LINKEDIN_ACCESS_CONFIRMED
 * @param {number}    opts.linkedinBudgetPerHour      - max HTTP transactions/hour for LinkedIn
 * @param {number}    opts.backoffMinutes             - initial backoff on first block (minutes)
 * @param {number}    opts.backoffMaxMinutes          - maximum backoff ceiling (minutes)
 * @param {Function}  opts.now                        - injectable clock, defaults to Date.now
 */
export function createSourcePolicy({
  disabled = [],
  linkedinAccessConfirmed = false,
  linkedinBudgetPerHour = 300,
  backoffMinutes = 60,
  backoffMaxMinutes = 1440,
  now = Date.now,
} = {}) {
  // Per-source exponential backoff state.
  // blockedUntil: timestamp (ms) the source is paused until.
  // backoffMs: the NEXT pause duration if blocked again.
  const blockedUntil = new Map();   // source -> timestamp ms
  const backoffMs = new Map();      // source -> current backoff in ms

  // Rolling window of LinkedIn request timestamps for the hourly budget.
  const linkedinRequests = [];

  const sourceFor = (host) => Object.keys(SOURCE_HOSTS).find((id) =>
    SOURCE_HOSTS[id].some((suffix) => host === suffix || host.endsWith(`.${suffix}`)));

  function initialBackoffMs() {
    return backoffMinutes * 60 * 1000;
  }
  function maxBackoffMs() {
    return backoffMaxMinutes * 60 * 1000;
  }

  return {
    beforeRequest(host) {
      const source = sourceFor(host);
      if (!source) return;

      // SOURCES_DISABLED check.
      if (disabled.includes(source)) {
        throw new SourcePolicyError(source, "disabled by SOURCES_DISABLED");
      }

      // LinkedIn-specific fail-closed gate.
      if (source === "linkedin" && !linkedinAccessConfirmed) {
        throw new SourcePolicyError(
          source,
          "LINKEDIN_ACCESS_CONFIRMED is not set — written authorization required"
        );
      }

      const instant = now();

      // Exponential circuit breaker: source still in cool-down window.
      if ((blockedUntil.get(source) || 0) > instant) {
        const remainMs = (blockedUntil.get(source) || 0) - instant;
        const remainMin = Math.ceil(remainMs / 60000);
        throw new SourcePolicyError(
          source,
          `requests paused after a blocked response (${remainMin} min remaining)`
        );
      }

      // Hourly budget for LinkedIn (counts actual HTTP hops, including redirects).
      if (source === "linkedin") {
        while (linkedinRequests.length && linkedinRequests[0] <= instant - 3600000) {
          linkedinRequests.shift();
        }
        if (linkedinRequests.length >= linkedinBudgetPerHour) {
          throw new SourcePolicyError(source, "rolling hourly request budget exhausted");
        }
        linkedinRequests.push(instant);
      }
    },

    /**
     * Record that `host` returned a blocking response (403 or 429).
     * Each call doubles the next pause for this source (exponential backoff),
     * capped at backoffMaxMinutes.
     */
    blocked(host, retryAfter) {
      const source = sourceFor(host);
      if (!source) return;

      const instant = now();

      // Compute exponential backoff for this source.
      const current = backoffMs.get(source) || initialBackoffMs();
      const next = Math.min(current * 2, maxBackoffMs());
      backoffMs.set(source, next);

      // Honour Retry-After if it is longer than our backoff.
      const seconds = retryAfter == null ? NaN : Number(retryAfter);
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds) * 1000
        : Date.parse(retryAfter) - instant;
      const effective = Math.max(
        current,
        Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0
      );

      blockedUntil.set(
        source,
        Math.max(blockedUntil.get(source) || 0, instant + effective)
      );
    },

    // Expose internal state for testing.
    _state: { blockedUntil, backoffMs, linkedinRequests },
  };
}

export const sourcePolicy = createSourcePolicy({
  disabled: env.disabledSources,
  linkedinAccessConfirmed: env.linkedinAccessConfirmed,
  linkedinBudgetPerHour: env.linkedinRequestBudgetPerHour,
  backoffMinutes: env.linkedinBlockedBackoffMinutes,
  backoffMaxMinutes: env.linkedinBlockedBackoffMaxMinutes,
});
