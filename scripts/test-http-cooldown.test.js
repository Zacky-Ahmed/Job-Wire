import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
let row = null;
const db = {
  findOne: async () => row,
  findOneAndUpdate: async (_, update) => {
    row = { failures: (row?.failures || 0) + 1, until: update.$max.until };
    return row;
  },
  updateOne: async (_, update) => { row.until = update.$max.until; },
  deleteOne: async () => { row = null; }
};
await mock.module('../src/config/db.js', { namedExports: { getDb: () => ({ collection: () => db }) } });
await mock.module('../src/config/env.js', { namedExports: { env: { fetchJitterMs: 0 } } });
await mock.module('dns/promises', { defaultExport: { lookup: async () => [{ address: '8.8.8.8' }] } });
const { guardedFetch } = await import('../src/services/http/guardedFetch.js');

test('one 429 stops subsequent search, detail and closure requests but not other sources', async () => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    requests++;
    return String(url).includes('linkedin.com')
      ? new Response('', { status: 429, headers: { 'retry-after': '7200' } })
      : new Response('other board');
  };
  try {
    await assert.rejects(guardedFetch('https://www.linkedin.com/jobs/search', ['linkedin.com']), { name: 'BlockedBySource' });
    assert.ok(+row.until > Date.now() + 7190000);
    for (const path of ['/jobs/search', '/jobs-guest/jobs/api/jobPosting/1', '/jobs/view/2']) {
      await assert.rejects(guardedFetch(`https://www.linkedin.com${path}`, ['linkedin.com']), { name: 'SourceCoolingDown' });
    }
    assert.equal(requests, 1);
    assert.equal(await guardedFetch('https://example.com/jobs', ['example.com']), 'other board');
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});
