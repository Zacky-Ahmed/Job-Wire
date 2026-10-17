import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
await mock.module('../src/config/db.js',{namedExports:{collections:{}}});
const {wireFilter}=await import('../src/models/seenJobs.js');
test('wire retains 14 days of collected jobs independently of posting date or email pack',()=>{
 const now=new Date('2026-10-15T10:00:00Z');
 const f=wireFilter([{queryId:'q',since:now,emailPack:'data-science'}],{now,source:'linkedin'});
 assert.equal(+f.firstSeenAt.$gte,+now-14*86400000);
 assert.equal(+f.firstSeenAt.$lte,+now);
 assert.deepEqual(f.queryId,{$in:['q']});
 assert.equal(f.postedAt,undefined);
 assert.equal(f.emailPack,undefined);
 assert.equal(f.jobId.$regex,'^linkedin:');
});
