import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { page } from '../utils/render.js';
import * as Subs from '../models/subscriptions.js';
import { wireFilter } from '../models/seenJobs.js';
import { headerState } from '../utils/header.js';
import { pollerSnapshot } from '../services/poller/snapshotFor.js';
import { FIELDS, preferenceFor, parsePreference, matchPreference, passesPreferences } from '../services/emailPreferences.js';
import { getSource, listSources } from '../services/sources/index.js';
import { safeApplyUrl } from '../utils/jobLinks.js';
export const workspaceRoutes=Router();
const saved=()=>collections.users();
const text=v=>typeof v==='string'?v.trim():'';
const esc=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function filters(raw){return {q:text(raw.q).slice(0,100),source:getSource(text(raw.source))?text(raw.source):'',range:raw.range==='24h'?'24h':'14d',sort:raw.sort==='oldest'?'oldest':'newest',match:raw.match==='yes',page:Math.min(2000,Math.max(1,parseInt(raw.page,10)||1))};}
async function context(req){const [watches,beat]=await Promise.all([Subs.listForUser(req.user._id),pollerSnapshot()]);return {user:req.user,watches,...headerState(watches,beat),sourceOptions:listSources(),emailFields:FIELDS,preferenceFor,emailNotice:null,emailPreview:null};}
const collectedFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Colombo',dateStyle:'short',timeStyle:'medium'});
const postedFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Colombo'});
export function jobView(j){return {...j,source:getSource(String(j.jobId).split(':')[0])?.label||'Job board',applyUrl:safeApplyUrl(j.url),collected:j.firstSeenAt?collectedFormat.format(new Date(j.firstSeenAt)):'Unknown',posted:j.postedAt?postedFormat.format(new Date(j.postedAt)):'Date unavailable'};}
for(const route of ['/wire','/saved'])workspaceRoutes.get(route,requireAuth,async(req,res,next)=>{try{
 const c=await context(req),f=filters(req.query),isSaved=route==='/saved';
 let items,dbTotal=null;
 const query=wireFilter(c.watches);
 if(f.source)query.jobId={$regex:'^'+esc(f.source)+':'};
 if(f.range==='24h')query.postedAt={$gte:new Date(Date.now()-86400000),$lte:new Date()};
 if(f.q)query.$or=['title','company','location'].map(k=>({[k]:{$regex:esc(f.q),$options:'i'}}));
 // Fetch metadata only. Preferences are title-based and must match the sender's rules.
 const projection={title:1,company:1,location:1,url:1,postedAt:1,firstSeenAt:1,jobId:1,queryId:1,openings:1};
 if(isSaved){items=(req.user.savedJobs||[]).map(x=>({...x.job,_id:x.id,savedAt:x.savedAt}));
 items=items.filter(j=>(!f.source||j.jobId.startsWith(f.source+':'))&&(!f.q||[j.title,j.company,j.location].join(' ').toLowerCase().includes(f.q.toLowerCase()))&&(f.range!=='24h'||(j.postedAt&&+new Date(j.postedAt)>=Date.now()-86400000&&+new Date(j.postedAt)<=Date.now())));
  }else if(!f.match){
 const direction=f.sort==='oldest'?1:-1;
 const pipeline=[{$match:query},{$sort:{firstSeenAt:-1,_id:-1}},{$group:{_id:'$jobId',job:{$first:'$$ROOT'}}},{$replaceRoot:{newRoot:'$job'}},{$project:projection},{$sort:{firstSeenAt:direction,_id:direction}},{$facet:{total:[{$count:'n'}],jobs:[{$skip:(f.page-1)*20},{$limit:20}]}}];
 const result=(await collections.seenJobs().aggregate(pipeline).toArray())[0];dbTotal=result?.total[0]?.n||0;items=result?.jobs||[];
 const maxPage=Math.max(1,Math.ceil(dbTotal/20));if(f.page>maxPage){f.page=maxPage;pipeline[pipeline.length-1].$facet.jobs[0].$skip=(f.page-1)*20;items=(await collections.seenJobs().aggregate(pipeline).toArray())[0]?.jobs||[];}
 }else items=await collections.seenJobs().find(query,{projection}).sort({firstSeenAt:-1,_id:-1}).toArray();
 const distinct=new Map();for(const j of items){if(!distinct.has(j.jobId))distinct.set(j.jobId,j)}items=[...distinct.values()];
 items=items.map(j=>({...j,interest:c.watches.some(w=>String(w.queryId)===String(j.queryId)&&passesPreferences(j,w))}));
 if(f.match)items=items.filter(j=>j.interest);
 items.sort((a,b)=>(+new Date(b.firstSeenAt)-+new Date(a.firstSeenAt)||String(b._id).localeCompare(String(a._id)))*(f.sort==='oldest'?-1:1));
 const total=dbTotal??items.length,pages=Math.max(1,Math.ceil(total/20));f.page=Math.min(f.page,pages);
 const jobs=(dbTotal===null?items.slice((f.page-1)*20,f.page*20):items).map(jobView),ids=new Set((req.user.savedJobs||[]).map(x=>x.job.jobId));
 jobs.forEach(j=>{j.saved=ids.has(j.jobId);j.saveId=j.saved?(req.user.savedJobs||[]).find(x=>x.job.jobId===j.jobId).id:String(j._id)});
 const href=n=>{const p=new URLSearchParams({q:f.q,source:f.source,range:f.range,sort:f.sort,page:String(n),...(f.match?{match:'yes'}:{})});return route+'?'+p};
 page(res,'pages/feed',{...c,title:isSaved?'Saved jobs':'The Wire',nav:isSaved?'saved':'wire',jobs,total,pages,f,isSaved,href});
 }catch(e){next(e)}});
workspaceRoutes.get('/interests',requireAuth,async(req,res,next)=>{try{page(res,'pages/interests',{...await context(req),title:'Email interests',nav:'interests'});}catch(e){next(e)}});
workspaceRoutes.post('/interests',requireAuth,async(req,res,next)=>{try{
 const id=text(req.body.subscriptionId);if(!/^[a-f0-9]{24}$/i.test(id))return res.status(400).send('Invalid watch');
 const sub=await collections.subscriptions().findOne({_id:new ObjectId(id),userId:req.user._id});if(!sub)return res.sendStatus(404);
 let pref;try{pref=parsePreference(req.body);}catch(e){return res.status(400).send(e.message)}
 if(!['save','preview'].includes(req.body.action))return res.sendStatus(400);
 if(req.body.action==='save')await collections.subscriptions().updateOne({_id:sub._id,userId:req.user._id},{$set:{emailPreferences:pref,emailPreferencesUpdatedAt:new Date()}});
 const jobs=await collections.seenJobs().find(wireFilter([{queryId:sub.queryId}]),{projection:{title:1}}).toArray();
 const matches=jobs.map(j=>({...j,...matchPreference(j,pref)})).filter(j=>j.matches);
 page(res,'pages/interests',{...await context(req),title:'Email interests',nav:'interests',emailPreview:{subscriptionId:id,pref,total:jobs.length,count:matches.length,examples:matches.slice(0,20)},emailNotice:req.body.action==='save'?'Saved. Applies to future and unsent queued alerts; old jobs are not resent.':'Preview only. Your saved preferences have not changed.'});
 }catch(e){next(e)}});
workspaceRoutes.post('/saved/:id',requireAuth,async(req,res,next)=>{try{
 const id=req.params.id;if(!/^[a-f0-9]{24}$/i.test(id)||!['save','remove'].includes(req.body.action))return res.sendStatus(400);
 if(req.body.action==='remove'){await saved().updateOne({_id:req.user._id},{$pull:{savedJobs:{id}}});}
 else {const watches=await Subs.listForUser(req.user._id);const job=await collections.seenJobs().findOne({...wireFilter(watches),_id:new ObjectId(id)},{projection:{title:1,company:1,location:1,url:1,jobId:1,queryId:1,postedAt:1,firstSeenAt:1}});if(!job)return res.status(404).send('Job expired or unavailable.');
 const result=await saved().updateOne({_id:req.user._id,'savedJobs.job.jobId':{$ne:job.jobId},'savedJobs.499':{$exists:false}},{$push:{savedJobs:{id,job,savedAt:new Date()}}});
 if(!result.modifiedCount&&!(req.user.savedJobs||[]).some(x=>x.job.jobId===job.jobId))return res.status(409).send('Your shortlist is full. Remove an item before saving another.');}
 if(req.get('accept')==='application/json')return res.json({ok:true});res.redirect(303,req.body.returnTo==='/saved'?'/saved':'/wire');
 }catch(e){next(e)}});
workspaceRoutes.get('/wire/job/:id',requireAuth,async(req,res,next)=>{try{
 if(!/^[a-f0-9]{24}$/i.test(req.params.id))return res.sendStatus(404);
 const c=await context(req);let j=await collections.seenJobs().findOne({...wireFilter(c.watches),_id:new ObjectId(req.params.id)});
 if(!j)j=(req.user.savedJobs||[]).find(x=>x.id===req.params.id)?.job;
 if(!j)return res.sendStatus(404);const v=jobView(j);
 res.render('pages/job',{title:j.title,job:j,postedDate:v.posted,sourceLabel:v.source,applyUrl:v.applyUrl});
 }catch(e){next(e)}});
workspaceRoutes.get('/delivery',requireAuth,async(req,res,next)=>{try{
 const [c,rows]=await Promise.all([context(req),collections.outbox().find({userId:req.user._id},{projection:{job:1,status:1,createdAt:1,sentAt:1,nextAttemptAt:1,attempts:1}}).sort({createdAt:-1,_id:-1}).limit(100).toArray()]);
 page(res,'pages/delivery',{...c,title:'Delivery',nav:'delivery',rows:rows.map(row=>({...row,createdLabel:collectedFormat.format(new Date(row.createdAt)),retryLabel:row.nextAttemptAt?collectedFormat.format(new Date(row.nextAttemptAt)):null}))});
 }catch(e){next(e)}});

workspaceRoutes.get('/admin/trace',requireAuth,requireAdmin,async(req,res,next)=>{try{
 const c=await context(req),jobId=text(req.query.jobId).slice(0,200);
 const records=jobId?await collections.seenJobs().find({jobId},{projection:{title:1,queryId:1,firstSeenAt:1,postedAt:1,matched:1}}).limit(30).toArray():[];
 const states=jobId?await collections.outbox().aggregate([{$match:{jobId}},{$group:{_id:'$status',count:{$sum:1}}}]).toArray():[];
 page(res,'pages/trace',{...c,title:'Alert tracing',nav:'admin',jobId,records,states});
 }catch(e){next(e)}});
workspaceRoutes.get('/wire/version',requireAuth,async(req,res,next)=>{try{const watches=await Subs.listForUser(req.user._id);const latest=await collections.seenJobs().find(wireFilter(watches),{projection:{firstSeenAt:1}}).sort({firstSeenAt:-1,_id:-1}).limit(1).toArray();res.set('Cache-Control','private, no-store').json({latest:latest[0]?String(latest[0]._id):null});}catch(e){next(e)}});
