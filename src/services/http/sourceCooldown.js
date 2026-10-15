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

export function createCooldown({ collection, now = Date.now, baseMs = 30 * 60000 }) {
  let localUntil = 0;
  return {
    async enter() {
      if (localUntil > now()) throw new SourceCoolingDown(localUntil);
      const state = await collection().findOne({ _id: 'linkedin' });
      if (!state?.failures) return false;
      const until = Math.max(+new Date(state.until), +new Date(state.probeUntil || 0));
      if (until > now()) throw new SourceCoolingDown(until);
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
      const state = await collection().findOneAndUpdate(
        { _id: 'linkedin' }, { $inc: { failures: 1 },
          $max: { until: new Date(localUntil) }, $unset: { probeUntil: '', healthySince: '' } },
        { upsert: true, returnDocument: 'after' }
      );
      localUntil = now() + Math.max(
        Math.min(6 * 3600000, baseMs * 2 ** Math.min(10, state.failures - 1)),
        retryAfterMs(retryAfter, now())
      );
      await collection().updateOne({ _id: 'linkedin' }, {
        $max: { until: new Date(localUntil) }, $unset: { probeUntil: '' }
      });
      return localUntil;
    },
    async recovered() {
      const state = await collection().findOne({ _id: 'linkedin' });
      if (state?.healthySince && now() - +new Date(state.healthySince) >= 3600000) {
        await collection().deleteOne({ _id: 'linkedin' });
      } else {
        await collection().updateOne({ _id: 'linkedin' }, {
          $set: { healthySince: state?.healthySince || new Date(now()), until: new Date(now() + 300000) },
          $unset: { probeUntil: '' },
        });
      }
      localUntil = 0;
    }
  };
}
