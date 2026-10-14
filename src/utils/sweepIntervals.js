// Validation and scheduling math for admin-enforced shared search cadences.
// Kept independent of Mongo, Express and environment to make safety rules testable.

export const ADMIN_MIN_SWEEP_MINUTES = 5;
export const ADMIN_MAX_SWEEP_MINUTES = 60;

/** A POST must contain a plain whole number within the configured floor. */
export function parseAdminSweepMinutes(raw, min = ADMIN_MIN_SWEEP_MINUTES) {
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= min && n <= ADMIN_MAX_SWEEP_MINUTES
    ? n : null;
}

/** A manual admin setting wins over the faster of the subscriber requests. */
export function effectiveSweepMinutes(query, requested) {
  const admin = query?.adminEveryMinutes;
  return Number.isSafeInteger(admin) && admin >= ADMIN_MIN_SWEEP_MINUTES
    && admin <= ADMIN_MAX_SWEEP_MINUTES ? admin : requested;
}

/**
 * Set the authoritative interval without defeating a failure backoff,
 * reviving a parked query, or starting an extra parallel sweep.
 *
 * When a query is between sweeps, move its pending deadline to the next
 * slot on the new cadence. An already-due / in-flight sweep finishes
 * naturally, and reschedule() reads the persisted new interval.
 */
export function adminIntervalPatch(query, minutes, now = new Date()) {
  const patch = { adminEveryMinutes: minutes, everyMinutes: minutes };
  const due = query?.nextFetchAt == null ? NaN : new Date(query.nextFetchAt).getTime();
  const at = new Date(now).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(at) || due <= at || query.failCount) {
    return patch;
  }

  const previous = Number(query.everyMinutes);
  const last = query.lastFetchedAt ? new Date(query.lastFetchedAt).getTime() : NaN;
  const anchor = Number.isFinite(last) ? last : at;
  const target = Math.max(at + 1000, anchor + minutes * 60_000);

  if ((minutes > previous && target > due) ||
      (minutes < previous && target < due)) {
    patch.nextFetchAt = new Date(target);
  }
  return patch;
}
