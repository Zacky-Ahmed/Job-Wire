// LinkedIn alone is allowed to cool down. Never delay unrelated job sources.
// A cooldown is persisted so a Docker restart does not immediately retry a 429.
import { collections } from "../../config/db.js";
import { log } from "../../utils/logger.js";

const SOURCE = "linkedin";
const CACHE_MS = 3000;
const MAX_BACKOFF_MS = 30 * 60_000;
let localUntilMs = 0;
let cachedUntilMs = 0;
let checkedAtMs = 0;

export class LinkedInCoolingDown extends Error {
  constructor(untilMs) {
    super(`LinkedIn cooling down until ${new Date(untilMs).toISOString()}`);
    this.name = "LinkedInCoolingDown";
    this.untilMs = untilMs;
  }
}

// Retry-After can be seconds or an HTTP date. Respect dates longer than
// our fallback backoff, up to 24 hours to reject implausible values safely.
export function retryAfterMs(value, nowMs = Date.now()) {
  if (!value) return null;
  const str = String(value).trim();
  const ms = /^\d+$/.test(str) ? Number(str) * 1000 : Date.parse(str) - nowMs;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, 24 * 60 * 60_000);
}

export function isCoolingDown(nowMs = Date.now()) {
  return nowMs < Math.max(localUntilMs, cachedUntilMs);
}

export async function beforeRequest() {
  const now = Date.now();
  if (isCoolingDown(now)) throw new LinkedInCoolingDown(Math.max(localUntilMs, cachedUntilMs));
  if (now - checkedAtMs < CACHE_MS) return;
  try {
    const row = await collections.sourceState().findOne(
      { _id: SOURCE }, { projection: { cooldownUntil: 1 } }
    );
    cachedUntilMs = row?.cooldownUntil ? new Date(row.cooldownUntil).getTime() : 0;
    checkedAtMs = Date.now();
  } catch (err) {
    // A transient Atlas problem should not make a working source vanish.
    // The immediately observed 429 still remains enforced locally.
    log.warn("could not read LinkedIn cooldown", { message: err.message });
    checkedAtMs = Date.now();
  }
  if (isCoolingDown()) throw new LinkedInCoolingDown(Math.max(localUntilMs, cachedUntilMs));
}

export async function noteBlocked(error) {
  if (error?.status !== 429 && error?.status !== 403) return;
  const now = Date.now();
  const retryMs = retryAfterMs(error.retryAfter, now);
  // Set an immediate local barrier before waiting for MongoDB.
  localUntilMs = Math.max(localUntilMs, now + Math.max(retryMs ?? 0, 60_000));
  checkedAtMs = now;

  try {
    const coll = collections.sourceState();
    const row = await coll.findOne({ _id: SOURCE }, { projection: { consecutiveBlocks: 1, cooldownUntil: 1 } });
    const count = Math.min(30, (row?.consecutiveBlocks || 0) + 1);
    const fallback = error.status === 403
      ? 15 * 60_000
      : Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(count - 1, 8));
    const until = Math.max(now + Math.max(fallback, retryMs ?? 0),
      row?.cooldownUntil ? new Date(row.cooldownUntil).getTime() : 0);
    localUntilMs = Math.max(localUntilMs, until);
    cachedUntilMs = Math.max(cachedUntilMs, until);
    await coll.updateOne({ _id: SOURCE }, {
      $set: { cooldownUntil: new Date(until), lastBlockedAt: new Date(now),
        lastBlockStatus: error.status, lastRetryAfter: error.retryAfter || null },
      $inc: { consecutiveBlocks: 1 },
    }, { upsert: true });
    log.warn("LinkedIn cooling down after source block", {
      status: error.status, minutes: Math.ceil((until - now) / 60_000),
      consecutiveBlocks: count,
    });
  } catch (err) {
    // If the database is down, avoid repeated requests during that outage.
    localUntilMs = Math.max(localUntilMs, now + 5 * 60_000);
    log.warn("could not persist LinkedIn cooldown; retaining local pause", { message: err.message });
  }
}

export async function noteHealthySweep() {
  if (isCoolingDown()) return;
  try {
    await collections.sourceState().updateOne(
      { _id: SOURCE },
      { $set: { consecutiveBlocks: 0, cooldownUntil: null, lastSuccessAt: new Date() } },
      { upsert: true }
    );
    cachedUntilMs = 0;
    localUntilMs = 0;
    checkedAtMs = Date.now();
  } catch (err) {
    log.warn("could not record LinkedIn recovery", { message: err.message });
  }
}
