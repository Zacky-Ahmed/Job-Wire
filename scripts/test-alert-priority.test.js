import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const noop = async () => {};
let events = [], jobs = [], pending = [], failures = [], sourceError = false, emailPack = null, displayed = [];
const source = {
  timePrecision: 'minute', maxPages: 1,
  fetchJobs: async () => { if (sourceError) throw Error('blocked'); return jobs; },
  refine: async items => {
    events.push('refine');
    return items.map(j => ({ ...j, matchKind: j.title.includes('Intern') ? 'title' : 'unverified', verificationDeferred: true }));
  },
  isClosed: async () => null
};
const moduleMock = (path, namedExports) => mock.module(path, { namedExports });
await moduleMock('../src/services/sources/index.js', { getSource: () => source, sourcesForCountry: () => ['linkedin'], DEFAULT_SOURCE: 'linkedin' });
await moduleMock('../src/services/http/guardedFetch.js', { BlockedBySource: class extends Error {}, getLinkedInCooldown: async () => null });
await moduleMock('../src/config/env.js', { env: {} });
await moduleMock('../src/config/db.js', { collections: {
  queries: () => ({ updateOne: noop }),
  users: () => ({ findOne: async () => ({ verified: true, email: 'test@example.invalid' }) })
} });
await moduleMock('../src/services/poller/loop.js', { noteProgress: noop });
await moduleMock('../src/services/mail/outboxWorker.js', { drainOutbox: async () => { events.push('deliver'); } });
await moduleMock('../src/services/poller/snapshot.js', { sharedFetch: async (_, __, fetchPages) => fetchPages(), isShared: () => false });
await moduleMock('../src/services/poller/dedupe.js', { diff: async () => ({ alertable: jobs, primed: false }) });
await moduleMock('../src/models/queries.js', { siblings: async () => [], recordFailure: noop, reschedule: async () => { events.push('reschedule'); } });
await moduleMock('../src/models/seenJobs.js', {
  pending: async () => pending, markPending: async (_, items, options) => { failures.push({ items, options }); },
  markMatched: async (_, items) => { displayed.push(...items.map(j=>j.jobId)); }, clearPending: noop, unmatch: noop, insertNew: noop
});


await moduleMock('../src/models/alertedJobs.js', { knownIds: async () => new Set(), remember: async (_, ids) => { events.push(['claim', ids]); } });
await moduleMock('../src/models/subscriptions.js', { activeSubscribers: async () => [{ _id: 'sub', userId: 'user', emailPack }] });
await moduleMock('../src/models/outbox.js', { enqueue: async items => { events.push(['enqueue', items.map(i => i.job.jobId)]); return { queued: items.length, alreadyQueued: 0 }; } });
await moduleMock('../src/models/observations.js', { record: noop, baseline: noop, isAnomalous: () => false });
await moduleMock('../src/models/sweepRuns.js', { open: noop, close: noop, noteSource: noop });
const { sweepQuery } = await import('../src/services/poller/sweep.js');
const query = { _id: 'query', keywords: ['Intern'], geoId: '100446352', everyMinutes: 5, primed: true };

test('queue and deliver obvious matches before verification, then record full timing', async () => {
  events = []; failures = []; pending = [];
  jobs = [
    { jobId: 'linkedin:1', title: 'Software Intern', postedAt: new Date() },
    { jobId: 'linkedin:2', title: 'Assistant', postedAt: new Date(), refineAttempts: 99 }
  ];
  const result = await sweepQuery(query);
  assert.equal(result.alerted, 1);
  assert.ok(events.indexOf('deliver') < events.indexOf('refine'));
  assert.ok(events.indexOf('reschedule') > events.indexOf('refine'));
  assert.deepEqual(events.find(e => Array.isArray(e) && e[0] === 'enqueue')[1], ['linkedin:1']);
  assert.ok(failures.some(f => f.items.some(j => j.jobId === 'linkedin:2') && !f.options?.failedAttempt));
  assert.ok(!failures.some(f => f.items.some(j => j.jobId === 'linkedin:2') && f.options?.failedAttempt));
  assert.ok(!events.some(e => Array.isArray(e) && e[0] === 'claim' && e[1].includes('linkedin:2')));
});

test('an older matching job stays pending when its closure check cannot complete', async () => {
  events = []; failures = []; pending = [];
  jobs = [{ jobId: 'linkedin:3', title: 'Software Intern', postedAt: new Date(Date.now() - 25 * 3600000) }];
  const result = await sweepQuery(query);
  assert.equal(result.alerted, 0);
  assert.ok(failures.some(f => f.items.some(j => j.jobId === 'linkedin:3')));
  assert.ok(!events.some(e => Array.isArray(e) && e[0] === 'claim' && e[1].includes('linkedin:3')));
});


test('all title matches reach the feed; Data Science only narrows email within 24 hours', async () => {
  events=[];failures=[];pending=[];displayed=[];emailPack='data-science';
  jobs=[
    {jobId:'linkedin:ds',title:'Data Science Intern',postedAt:new Date(Date.now()-6*3600000)},
    {jobId:'linkedin:brand',title:'Brand Marketing Intern',postedAt:new Date()},
  ];
  try {
    await sweepQuery(query);
    assert.ok(displayed.includes('linkedin:ds'));
    assert.ok(displayed.includes('linkedin:brand'));
    assert.deepEqual(events.find(e=>Array.isArray(e)&&e[0]==='enqueue')[1],['linkedin:ds']);
  } finally { emailPack=null; }
});
