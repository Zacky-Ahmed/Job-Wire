import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {ObjectId} from 'mongodb';
let writes=0;
const userId=new ObjectId(), subId=new ObjectId();
const sub={_id:subId,userId,queryId:'q'};
await mock.module('../src/config/db.js',{namedExports:{collections:{
 subscriptions:()=>({findOne:async f=>String(f._id)===String(subId)&&String(f.userId)===String(userId)?sub:null,updateOne:async f=>{assert.equal(String(f.userId),String(userId));writes++;}}),
 seenJobs:()=>({find:()=>({toArray:async()=>[{title:'Backend Engineer Intern'},{title:'HR Intern'}]})})
}}});
await mock.module('../src/middleware/requireAuth.js',{namedExports:{requireAuth:(req,res,next)=>{req.user={_id:userId};next();}}});
await mock.module('../src/utils/render.js',{namedExports:{page:(res,view,data)=>res.json({preview:data.emailPreview,notice:data.emailNotice})}});
await mock.module('../src/models/subscriptions.js',{namedExports:{listForUser:async()=>[]}});
await mock.module('../src/models/seenJobs.js',{namedExports:{wireFilter:()=>({}),recentForSubscriptions:async()=>[],countMatchedForSubscriptions:async()=>0,wireSourceCounts:async()=>[]}});
await mock.module('../src/models/emailLog.js',{namedExports:{countTodayForUser:async()=>0,countToday:async()=>0,forJobs:async()=>[]}});
await mock.module('../src/services/sources/index.js',{namedExports:{getSource:()=>null}});
await mock.module('../src/services/poller/snapshotFor.js',{namedExports:{pollerSnapshot:async()=>({})}});
await mock.module('../src/utils/header.js',{namedExports:{headerState:()=>({})}});
await mock.module('../src/config/env.js',{namedExports:{env:{}}});
await mock.module('../src/services/mail/transport.js',{namedExports:{dailyCap:()=>450,providerLabel:()=>''}});
const {wireRoutes}=await import('../src/routes/wire.routes.js');
test('preview is read only, save is owner scoped, invalid and other-user requests rejected',async()=>{
 const app=express();app.use(express.urlencoded({extended:false}),wireRoutes);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const post=body=>fetch(`http://127.0.0.1:${server.address().port}/wire/email-preferences`,{method:'POST',body:new URLSearchParams(body)});
 try {
  const form={subscriptionId:String(subId),mode:'selected',fields:'data-science',action:'preview'};
  const preview=await post(form);assert.equal(preview.status,200);assert.equal((await preview.json()).preview.count,1);assert.equal(writes,0);
  assert.equal((await post({...form,action:'save'})).status,200);assert.equal(writes,1);
  assert.equal((await post({...form,subscriptionId:String(new ObjectId()),action:'save'})).status,404);assert.equal(writes,1);
  assert.equal((await post({...form,fields:'invalid',action:'save'})).status,400);assert.equal(writes,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
