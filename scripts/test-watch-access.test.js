import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ejs from 'ejs';
await mock.module('../src/config/env.js',{namedExports:{env:{adminEmails:['admin@example.invalid']}}});
const {requireAdmin}=await import('../src/middleware/requireAdmin.js');
test('normal users cannot enter watch creation; administrators can',()=>{
 let passed=false,code=null;
 const res={status:n=>{code=n;return res;},type:()=>res,send:()=>{}};
 requireAdmin({user:{email:'normal@example.invalid'},get:()=>true},res,()=>{passed=true;});
 assert.equal(passed,false);assert.equal(code,404);
 requireAdmin({user:{email:'admin@example.invalid'}},res,()=>{passed=true;});assert.equal(passed,true);
});
test('normal users keep Hold, Resume and Delete on their existing watch',async()=>{
 const template=await readFile(new URL('../src/views/partials/watch-rows.ejs',import.meta.url),'utf8');
 for(const active of [true,false]){
 const html=ejs.render(template,{isAdmin:false,watches:[{_id:'sub',label:'Intern',active,q:{location:'Sri Lanka',everyMinutes:5,keywords:['Intern'],primed:true}}],csrfToken:'test',sourceLabel:x=>x,rel:()=>''});
 assert.ok(html.includes(active?'Hold':'Resume'));assert.ok(html.includes('/watches/sub/toggle'));assert.ok(html.includes('/watches/sub/delete'));assert.ok(!html.includes('/watches?new=1'));
 }
 const empty=ejs.render(template,{isAdmin:false,watches:[]});assert.ok(!empty.includes('/watches?new=1'));
});
