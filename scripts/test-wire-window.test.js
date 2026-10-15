import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
await mock.module('../src/config/db.js',{namedExports:{collections:{}}});
const {wireFilter}=await import('../src/models/seenJobs.js');
test('wire scope is publication date, independent of subscription age or email pack',()=>{
 const now=new Date('2026-10-15T10:00:00Z');
 const f=wireFilter([{queryId:'q',since:now,emailPack:'data-science'}],{now,source:'linkedin'});
 assert.equal(+f.postedAt.$gte,+now-86400000);
 assert.equal(+f.postedAt.$lte,+now);
 assert.deepEqual(f.queryId,{$in:['q']});
 assert.equal(f.firstSeenAt,undefined);
 assert.equal(f.emailPack,undefined);
 assert.equal(f.jobId.$regex,'^linkedin:');
});
