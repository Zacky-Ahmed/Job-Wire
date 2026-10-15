import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCooldown, retryAfterMs } from '../src/services/http/sourceCooldown.js';

function memoryStore() {
  let row = null;
  return {
    async findOne() { return row && { ...row }; },
    async findOneAndUpdate(filter, update) {
      if (filter.until && (!row || row.until > filter.until.$lte || row.probeUntil > filter.until.$lte)) return null;
      row ||= { _id: 'linkedin', failures: 0 };
      if (update.$inc) row.failures += update.$inc.failures;
      Object.assign(row, update.$set);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
      return { ...row };
    },
    async updateOne(_, update) {
      if (update.$max) row.until = new Date(Math.max(+row.until || 0, +update.$max.until));
      Object.assign(row, update.$set);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
    },
    async deleteOne() { row = null; }
  };
}

test('Retry-After supports seconds, dates and invalid input', () => {
  assert.equal(retryAfterMs('120', 0), 120000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000);
  assert.equal(retryAfterMs('nonsense'), 0);
});

test('cooldown survives restart; one recovery probe; repeated blocks extend pause', async () => {
  let time = 100000;
  const db = memoryStore();
  const make = () => createCooldown({ collection: () => db, now: () => time, baseMs: 1000 });
  const first = make();
  assert.equal(await first.enter(), false);
  await first.block('2');
  const restarted = make();
  await assert.rejects(restarted.enter(), { name: 'SourceCoolingDown' });
  time += 2001;
  assert.equal(await restarted.enter(), true);
  await assert.rejects(make().enter(), { name: 'SourceCoolingDown' });
  await restarted.block();
  assert.equal(+(await db.findOne()).until, time + 2000);
  time += 2001;
  assert.equal(await make().enter(), true);
  await restarted.recovered();
  await assert.rejects(make().enter(), { name: "SourceCoolingDown" });
  assert.equal((await db.findOne()).failures, 2);
  time += 300001;
  assert.equal(await make().enter(), true);
  await make().block();
  assert.equal((await db.findOne()).failures, 3);
  assert.equal((await db.findOne()).healthySince, undefined);
  time += 4001;
  const recovering = make();
  assert.equal(await recovering.enter(), true);
  await recovering.recovered();
  time += 3600001;
  assert.equal(await recovering.enter(), true);
  await recovering.recovered();
  assert.equal(await make().enter(), false);
});

test('a failed cooldown write still stops requests locally', async () => {
  const circuit = createCooldown({ collection: () => ({ findOneAndUpdate: async () => { throw Error('database down'); } }) });
  await assert.rejects(circuit.block(), /database down/);
  await assert.rejects(circuit.enter(), { name: 'SourceCoolingDown' });
});

await mock.module('../src/config/db.js', { namedExports: { getDb: () => ({ collection: () => ({ findOne: async () => null, updateOne: async () => {} }) }) } });
let handler;
await mock.module('../src/services/http/guardedFetch.js', { namedExports: { guardedFetch: (...args) => handler(...args) } });
await mock.module('../src/models/crawlLog.js', { namedExports: { record: async () => {} } });
await mock.module('../src/services/sources/index.js', { namedExports: { qualify: (source, id) => `${source}:${id}` } });
const linkedin = await import('../src/services/sources/linkedin.js');

test('first-page results survive a deferred deeper page', async () => {
  const urls = [];
  handler = async url => {
    urls.push(url);
    if (urls.length > 1) throw Object.assign(Error('rate limited'), { deferred: true });
    return '<li><div class="base-card" data-entity-urn="urn:li:jobPosting:123"><a href="/jobs/view/123/"></a><h3>Software Intern</h3><h4>Example</h4><span class="job-search-card__location">Sri Lanka</span><time>1 minute ago</time></div></li>';
  };
  const result = await linkedin.fetchJobs({ keywords: ['Intern'], geoId: '100446352' });
  assert.match(urls[0], /keywords=Intern/);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].jobId, 'linkedin:123');
  assert.equal(result.observation.status, 'degraded');
});

test('title matches need no requests; rate-limited verification remains deferred', async () => {
  linkedin.clearDetailCache();
  let calls = 0;
  handler = async () => { calls++; throw Object.assign(Error('cooldown'), { deferred: true }); };
  const jobs = await linkedin.refine([
    { jobId: 'linkedin:1', title: 'Software Intern' },
    { jobId: 'linkedin:2', title: 'Assistant', refineAttempts: 3 },
    { jobId: 'linkedin:3', title: 'Associate', refineAttempts: 3 }
  ], { keywords: ['Intern'] });
  assert.equal(calls, 1);
  assert.equal(jobs[0].matchKind, 'title');
  assert.equal(jobs[1].verificationDeferred, true);
  assert.equal(jobs[2].verificationDeferred, true);
});


test('a full result page never triggers an unbounded crawl', async () => {
  let calls = 0;
  handler = async () => {
    calls++;
    return '<li><div class="base-card" data-entity-urn="urn:li:jobPosting:123"><a href="/jobs/view/123/"></a><h3>Software Intern</h3><h4>Example</h4><span class="job-search-card__location">Sri Lanka</span></div></li>';
  };
  const result = await linkedin.fetchJobs({ keywords: ['Intern'], geoId: '100446352' });
  assert.equal(calls, 2);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.observation.requests, 2);
});
