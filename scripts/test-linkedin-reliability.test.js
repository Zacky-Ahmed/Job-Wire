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
  const make = () => createCooldown({ collection: () => db, now: () => time, baseMs: 1000, sleep: async ms => { time += ms; } });
  const first = make();
  assert.equal(await first.enter({ discovery: true }), false);
  await first.block('2');
  const restarted = make();
  await assert.rejects(restarted.enter({ discovery: true }), { name: 'SourceCoolingDown' });
  time += 2001;
  assert.equal(await restarted.enter({ discovery: true }), true);
  await assert.rejects(make().enter({ discovery: true }), { name: 'SourceCoolingDown' });
  await restarted.block();
  assert.equal(+(await db.findOne()).until, time + 2000);
  time += 2001;
  assert.equal(await make().enter({ discovery: true }), true);
  await restarted.recovered();
  await assert.rejects(make().enter(), { name: "SourceCoolingDown" });
  assert.equal((await db.findOne()).failures, 2);
  time += 300001;
  assert.equal(await make().enter({ discovery: true }), true);
  await make().block();
  assert.equal((await db.findOne()).failures, 3);
  assert.equal((await db.findOne()).healthySince, undefined);
  time += 4001;
  const recovering = make();
  assert.equal(await recovering.enter({ discovery: true }), true);
  await recovering.recovered();
  time += 3600001;
  assert.equal(await recovering.enter({ discovery: true }), true);
  await recovering.recovered();
  assert.equal(await make().enter({ discovery: true }), false);
});

test('a failed cooldown write still stops requests locally', async () => {
  const circuit = createCooldown({ collection: () => ({ findOneAndUpdate: async () => { throw Error('database down'); } }) });
  await assert.rejects(circuit.block(), /database down/);
  await assert.rejects(circuit.enter({ discovery: true }), { name: 'SourceCoolingDown' });
});

let cursorRow = null;
await mock.module('../src/config/db.js', { namedExports: { getDb: () => ({ collection: () => ({ findOne: async () => cursorRow, updateOne: async (_, update) => { cursorRow = {...update.$set}; } }) }) } });
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

test('search membership accepts related titles without any detail request', async () => {
  let calls=0;handler=async()=>{calls++;throw Error('unexpected request');};
  const jobs=await linkedin.refine([{jobId:'linkedin:1',title:'Junior Executive',sourceSearch:true},
    {jobId:'linkedin:2',title:'Software Intern'}],{keywords:['Intern']});
  assert.equal(calls,0);assert.equal(jobs.length,2);assert.equal(jobs[0].matchKind,'search');
  assert.equal(await linkedin.isClosed('linkedin:1'),null);assert.equal(calls,0);
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


test('recovery waits for small timing drift and reserves the probe for discovery', async () => {
  let time = 100000;
  const db = memoryStore();
  const circuit = createCooldown({ collection: () => db, now: () => time, baseMs: 1000,
    sleep: async ms => { time += ms; } });
  await circuit.block(); time += 1001;
  assert.equal(await circuit.enter({ discovery: true }), true);
  await circuit.recovered();
  time += 299000;
  await assert.rejects(circuit.enter(), { name: 'SourceCoolingDown' });
  assert.equal(await circuit.enter({ discovery: true }), true);
  assert.ok(time >= 401001);
  await assert.rejects(circuit.enter(), { name: 'SourceCoolingDown' });
});


test('admin distinguishes recovery, pauses and real failures', async () => {
  const { default: ejs } = await import('ejs');
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(new URL('../src/views/partials/admin/health.ejs', import.meta.url), 'utf8');
  for (const [status, label] of [['recovering','Recovering'], ['paused','Paused'], [null,'Failing']]) {
    const html = ejs.render(template, { poller: {}, sourceHealth: [{ source:'linkedin', status, ok:false, error:'status', seen:'now', failing:0 }] });
    assert.ok(html.includes('>'+label+'</span>'));
    if (status) assert.ok(!html.includes('>Failing</span>'));
  }
});

test('runtime never carries a previous crawl page into a new sweep', async () => {
  const { pollerRuntime } = await import('../src/services/poller/runtime.js');
  const beat = { state:'working', currentQueryId:'new', currentSince:new Date(2000), lastProgressAt:new Date(1000), currentSource:'linkedin', currentSurface:'countryFeed', currentPage:19 };
  const stale = pollerRuntime(beat, null, {enabled:true,now:3000});
  assert.equal(stale.currentPage,null);
  const current = pollerRuntime({...beat,lastProgressAt:new Date(2500),currentPage:0},null,{enabled:true,now:3000});
  assert.equal(current.currentPage,0);
});


const card = (id,title='Junior Executive') => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}"><a href="/jobs/view/${id}/"></a><h3>${title}</h3><h4>Example</h4><span class="job-search-card__location">Sri Lanka</span></div></li>`;
test('exact Sri Lanka public URL and complete first page require one request',async()=>{
 const urls=[];handler=async url=>{urls.push(url);return '<span class="results-context-header__job-count">17</span>'+Array.from({length:17},(_,i)=>card(100+i)).join('');};
 const r=await linkedin.fetchJobs({keywords:['Intern'],geoId:'100446352'});
 assert.equal(urls.length,1);const u=new URL(urls[0]);
 assert.equal(u.hostname,'lk.linkedin.com');assert.equal(u.pathname,'/jobs/search');
 assert.equal(u.searchParams.get('f_TPR'),'r86400');assert.equal(u.searchParams.get('pageNum'),'0');
 assert.equal(r.jobs.length,17);assert.ok(r.jobs.every(j=>j.sourceSearch));
});
test('unfinished search fetches at most two public pages, deduplicating IDs',async()=>{
 const urls=[];handler=async url=>{urls.push(url);return '<span class="results-context-header__job-count">80</span>'+card(1)+card(urls.length+1);};
 const r=await linkedin.fetchJobs({keywords:['Intern'],geoId:'100446352'});
 assert.equal(urls.length,2);const second=new URL(urls[1]);
 assert.equal(second.searchParams.get('start'),'25');assert.equal(second.searchParams.get('pageNum'),'1');
 assert.ok(urls.every(u=>!u.includes('jobs-guest')));assert.equal(r.jobs.length,3);
});
test('small challenge HTML is a failure, never a quiet empty search',async()=>{
 handler=async()=>'<html>Please sign in</html>';
 await assert.rejects(linkedin.fetchJobs({keywords:['Intern'],geoId:'100446352'}),/no recognised/);
});
test('hidden end marker does not truncate results',()=>{
 assert.equal(linkedin.searchComplete('<div class="see-more-jobs__viewed-all hidden">done</div>',10),false);
 assert.equal(linkedin.searchComplete('<div class="see-more-jobs__viewed-all">done</div>',10),true);
});
