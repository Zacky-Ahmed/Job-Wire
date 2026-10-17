// One durable circuit for every LinkedIn endpoint and watch.
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export class SourceCoolingDown extends Error {
  constructor(until) {
    super(`LinkedIn paused until ${new Date(until).toISOString()}`);
    this.name = 'SourceCoolingDown';
    this.retryAt = until;
    this.deferred = true;
  }
}

export function createCooldown({ collection, now = Date.now, baseMs = 10 * 60000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let localUntil = 0;
  return {
    async enter({ discovery = false } = {}) {
      if (localUntil > now() && (!discovery || localUntil - now() > 60000)) throw new SourceCoolingDown(localUntil);
      const state = await collection().findOne({ _id: 'linkedin' });
      if (!state?.failures) {
        if (localUntil > now()) throw new SourceCoolingDown(localUntil);
        return false;
      }
      // Only listing discovery may claim recovery; details must not steal its slot.
      if (!discovery) throw new SourceCoolingDown(+new Date(state.until));
      const until = Math.max(localUntil, +new Date(state.until), +new Date(state.probeUntil || 0));
      if (until > now()) {
        // Absorb small scheduler/HTTP drift without skipping an entire poll.
        // Re-read after waiting: another worker may have extended the cooldown.
        if (until - now() <= 60000) {
          await sleep(until - now() + 20);
          return this.enter({ discovery });
        }
        throw new SourceCoolingDown(until);
      }
      // Only one worker gets the recovery request, even across restarts.
      const probe = await collection().findOneAndUpdate(
        { _id: 'linkedin', until: { $lte: new Date(now()) },
          $or: [{ probeUntil: { $exists: false } }, { probeUntil: { $lte: new Date(now()) } }] },
        { $set: { probeUntil: new Date(now() + 60000) } },
        { returnDocument: 'after' }
      );
      if (!probe) throw new SourceCoolingDown(now() + 60000);
      return true;
    },
    async block(retryAfter = null) {
      // Fail closed in this process even if persistence is temporarily unavailable.
      localUntil = now() + Math.max(baseMs, retryAfterMs(retryAfter, now()));
      await collection().findOneAndUpdate(
        { _id: 'linkedin' }, {
          $inc: { failures: 1 },
          $max: { until: new Date(localUntil) },
          $set: { policy: 'skip-one-poll', lastBlockedAt: new Date(now()),
            retryAfterUntil: new Date(now() + retryAfterMs(retryAfter, now())) },
          $unset: { probeUntil: '', healthySince: '' }
        }, { upsert: true, returnDocument: 'after' }
      );
      return localUntil;
    },
    async recovered() {
      // Successful retry resumes ordinary bounded polling immediately.
      await collection().deleteOne({ _id: 'linkedin' });
      localUntil = 0;
    }
  };
}
