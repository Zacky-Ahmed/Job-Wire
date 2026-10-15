export class RequestBudgetDeferred extends Error {
  constructor() {
    super('LinkedIn request budget used; remaining work deferred to a later poll');
    this.name = 'RequestBudgetDeferred';
    this.deferred = true;
  }
}

// Shared by search, detail requests and every watch. Mongo makes claims atomic.
export async function takeRequestSlot(collection, now = Date.now()) {
  const row = await collection.findOneAndUpdate({ _id: 'linkedin' }, [
    { $set: { slots: { $filter: { input: { $ifNull: ['$slots', []] }, as: 'slot',
      cond: { $gt: ['$$slot', new Date(now - 300000)] } } } } },
    { $set: { admitted: { $lt: [{ $size: '$slots' }, 3] } } },
    { $set: { slots: { $cond: ['$admitted', { $concatArrays: ['$slots', [new Date(now)]] }, '$slots'] } } },
  ], { upsert: true, returnDocument: 'after' });
  if (!row.admitted) throw new RequestBudgetDeferred();
}
