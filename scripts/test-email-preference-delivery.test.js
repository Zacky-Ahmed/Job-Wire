import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
let rows=[],cancelled=[],sent=[];
const noop=async()=>{};
await mock.module('../src/models/outbox.js',{namedExports:{reclaimStale:async()=>0,claimBatch:async()=>rows,cancel:async ids=>cancelled.push(...ids),sealBatch:async()=>({batchKey:'key',mailProvider:'test'}),settleSent:async ids=>sent.push(...ids)}});
await mock.module('../src/models/emailLog.js',{namedExports:{countToday:async()=>0,open:async()=>1,settle:noop}});
await mock.module('../src/config/db.js',{namedExports:{collections:{subscriptions:()=>({findOne:async()=>({active:true,emailPreferences:{mode:'selected',fields:[],include:['python'],exclude:[]}})}),users:()=>({findOne:async()=>({verified:true,email:'test@example.invalid'})})}}});
await mock.module('../src/services/mail/send.js',{namedExports:{sendAlert:noop}});
await mock.module('../src/services/mail/transport.js',{namedExports:{chooseProvider:async()=>'test',dailyCap:()=>450}});
await mock.module('../src/services/mail/providerHealth.js',{namedExports:{canSend:()=>({ok:true}),health:()=>({state:'ready'}),READY:'ready',noteSuccess:()=>{}}});
const {drainOutbox}=await import('../src/services/mail/outboxWorker.js');
const fixtures=()=>[{_id:'a',subscriptionId:'s',userId:'u',jobId:'a',job:{title:'Python Developer Intern'}},{_id:'b',subscriptionId:'s',userId:'u',jobId:'b',job:{title:'HR Intern'}}];
test('delivery rechecks changed preferences before submitting a queued message',async()=>{
 rows=fixtures();cancelled=[];sent=[];let payload;
 await drainOutbox({send:async p=>{payload=p;return {ok:true};}});
 assert.deepEqual(cancelled,['b']);assert.deepEqual(sent,['a']);assert.equal(payload.jobs.length,1);assert.equal(payload.jobs[0].title,'Python Developer Intern');
});
test('a previously sealed batch is never resent with a changed payload',async()=>{
 rows=fixtures().map(r=>({...r,batchId:'existing'}));cancelled=[];sent=[];
 await drainOutbox({send:async()=>{throw Error('must not send');}});
 assert.deepEqual(cancelled,['a','b']);assert.deepEqual(sent,[]);
});
