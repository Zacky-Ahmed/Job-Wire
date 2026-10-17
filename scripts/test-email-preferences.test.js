import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePreference,matchPreference,preferenceFor,passesPreferences} from '../src/services/emailPreferences.js';
const ds=parsePreference({mode:'selected',fields:'data-science'});
const se=parsePreference({mode:'selected',fields:'software-engineering'});
test('real title variants match without matching sales or data entry',()=>{
 for(const title of ['Full-Stack Software Engineering Intern','AI / Data Engineering Intern','Backend Engineer Intern','IT Internship Opportunities - FE, BE, QA & BA','Machine Learning Engineer Intern','Python Developer Intern'])assert.equal(matchPreference(title,ds).matches,true,title);
 for(const title of ['Data Entry Assistant','Sales Intern (Software Sales)','Digital Marketing Intern (AI Product & Growth)','HR Intern - Talent Development','Laboratory Analyst Internship'])assert.equal(matchPreference(title,ds).matches,false,title);
 assert.equal(matchPreference('QA Intern – Playwright Automation',se).matches,true);
});
test('custom interests, exclusions and uncertain roles are explicit',()=>{
 const pref=parsePreference({mode:'selected',include:'python, React',exclude:'senior',name:'My roles'});
 assert.equal(matchPreference('Python Developer Intern',pref).matches,true);
 assert.equal(matchPreference('Senior Python Developer',pref).matches,false);
 assert.equal(matchPreference('IT Intern',ds).matches,false);
 assert.equal(matchPreference('IT Intern',{...ds,includeUncertain:true}).matches,true);
 assert.equal(matchPreference('QA Intern',se).matches,false);
 assert.equal(matchPreference('Intern - Quality Assurance & Regulatory Compliance',se).matches,false);
});
test('existing Data Science users retain selected preferences and all stays all',()=>{
 assert.equal(preferenceFor({emailPack:'data-science'}).fields[0],'data-science');
 assert.equal(passesPreferences({title:'HR Intern'},{}),true);
 assert.equal(passesPreferences({title:'HR Intern'},{emailPack:'data-science'}),false);
});
test('validation rejects invalid fields, empty selections and oversized phrases',()=>{
 for(const body of [{mode:'selected'},{mode:'bad'},{mode:'selected',fields:'bad'},{mode:'selected',include:'x'.repeat(81)},{mode:'all',exclude:{x:1}}])assert.throws(()=>parsePreference(body));
 assert.equal(matchPreference('AI Engineer Intern',parsePreference({mode:'selected',include:'ai'})).matches,true);
 assert.equal(matchPreference('Retail Intern',parsePreference({mode:'selected',include:'ai'})).matches,false);
});


test('email interests template renders eight fields and escapes custom values',async()=>{
 const {default:ejs}=await import('ejs');
 const {FIELDS}=await import('../src/services/emailPreferences.js');
 const html=await ejs.renderFile(new URL('../src/views/partials/email-preferences.ejs',import.meta.url).pathname,{watches:[{_id:'demo',label:'Intern',emailPreferences:{mode:'selected',fields:['data-science'],include:['<script>'],exclude:[],name:'My roles'}}],emailFields:FIELDS,preferenceFor,emailPreview:null,emailNotice:null,csrfToken:'test'});
 assert.equal((html.match(/name="fields"/g)||[]).length,8);
 assert.ok(html.includes('Preview matches'));assert.ok(html.includes('Save email interests'));
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
});
