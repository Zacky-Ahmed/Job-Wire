import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../public/js/feed-live.js',import.meta.url),'utf8');
async function setup(search='', scrollY=0) {
  const listeners={}, updates=[], notice={hidden:true}; let tick, id='old';
  const main={contains:()=>false,hasAttribute:()=>false};
  const document={hidden:false,activeElement:null,getElementById:n=>n==='workspaceMain'?main:notice,
    querySelector:s=>s==='#newJobsNotice a'?{}:null,addEventListener:(n,f)=>listeners[n]=f};
  const htmx={ajax:async(...args)=>updates.push(args)};
  vm.runInNewContext(script,{document,window:{scrollY,htmx},htmx,location:{pathname:'/wire',search},URLSearchParams,
    fetch:async()=>({ok:true,json:async()=>({latest:id})}),setInterval:f=>tick=f});
  await new Promise(setImmediate);
  return {updates,notice,document,listeners,main,async change(){id='new';await tick()}};
}
test('new arrivals update only the content and preserve applied filters',async()=>{
  const x=await setup('?source=linkedin&q=data');await x.change();
  assert.equal(x.updates.length,1);assert.equal(x.updates[0][1],'/wire?source=linkedin&q=data');
  assert.equal(x.updates[0][2].target,'#workspaceMain');
});
test('later pages and reading positions show notice without replacing results',async()=>{
  for(const [query,scroll] of [['?page=2',0],['',300],['?sort=oldest',0]]){
    const x=await setup(query,scroll);await x.change();assert.equal(x.updates.length,0);assert.equal(x.notice.hidden,false);
  }
});
test('unsaved filters and hidden tabs are not refreshed',async()=>{
  const x=await setup();x.listeners.input({target:{closest:()=>true}});await x.change();assert.equal(x.updates.length,0);
  const y=await setup();y.document.hidden=true;await y.change();assert.equal(y.updates.length,0);
});
