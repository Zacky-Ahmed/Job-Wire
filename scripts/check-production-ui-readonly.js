import express from 'express';
import {connectDb,collections,closeDb} from '../src/config/db.js';
import {workspaceRoutes} from '../src/routes/workspace.routes.js';
import {adminRoutes} from '../src/routes/admin.routes.js';
import {watchesRoutes} from '../src/routes/watches.routes.js';
import {jobRoutes} from '../src/routes/job.routes.js';
import {env} from '../src/config/env.js';
await connectDb();
const user=await collections.users().findOne({email:{$in:env.adminEmails},verified:true},{projection:{_id:1,sessionVersion:1}});if(!user)throw Error('No verified administrator for read-only render check');
const app=express();app.set('view engine','ejs');app.set('views',process.cwd()+'/src/views');
app.use((req,res,next)=>{req.session={userId:String(user._id),sessionVersion:user.sessionVersion||0};Object.assign(res.locals,{theme:'light',csrfToken:'render-check',asset:x=>x,siteOrigin:env.appUrl});next()});
app.use(workspaceRoutes);app.use(adminRoutes);app.use(watchesRoutes);app.use(jobRoutes);app.use((err,req,res,next)=>{process.stderr.write('render failure '+req.path+': '+err.message+'\n');res.sendStatus(500)});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const root='http://127.0.0.1:'+server.address().port;
let failures=0;
for(const route of ['/wire','/wire?q=intern&range=24h','/wire?match=yes','/saved','/interests','/delivery','/watches','/admin','/admin/trace']){const start=Date.now();const res=await fetch(root+route);const html=await res.text();const ok=res.status===200&&html.includes('Job Wire')&&!html.includes('DESIGN LAB');console.log(JSON.stringify({route,status:res.status,ok,ms:Date.now()-start,bytes:html.length}));if(!ok)failures++;}
const job=await collections.seenJobs().findOne({matched:{$ne:false}},{projection:{_id:1}});if(job){const res=await fetch(root+'/wire/job/'+job._id);console.log(JSON.stringify({route:'authenticated job',status:res.status}));if(![200,404].includes(res.status))failures++;}
const alert=await collections.outbox().findOne({'job.title':{$exists:true}},{projection:{_id:1}});if(alert){const res=await fetch(root+'/job/'+alert._id);console.log(JSON.stringify({route:'public email job',status:res.status}));if(res.status!==200)failures++;}
server.close();await closeDb();process.exitCode=failures?1:0;
