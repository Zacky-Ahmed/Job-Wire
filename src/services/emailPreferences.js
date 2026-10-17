import { passesPack } from './packs.js';
// Title-based suggestions derived from the supplied specialisation guide.
// These are relevance rules, not academic approval or job eligibility decisions.
export const TOPICS = {
 webmedia: ['Web, mobile & interactive development', /\b(front ?end|web (develop\w*|engineer\w*)|mobile|android|ios|game develop\w*|unity|unreal|wordpress|ar vr)\b/i],
 data: ['Data & analytics', /\b(data (science|scientist|analyst|analytics|engineer\w*|architect|warehouse|quality|governance)|big data|business (intelligence|analytics)|power bi|tableau|etl|analytics|bi (developer|engineer|analyst))\b/i],
 ai: ['AI & machine learning', /\b(machine learning|deep learning|artificial intelligence|computer vision|nlp|llm|genai|gen ai|agentic|mlops|ml ops|prompt engineer\w*|context engineer\w*|ai|ml)\b/i],
 software: ['Software development', /\b(software (engineer\w*|develop\w*|architect)|full ?stack|back ?end|front ?end (develop\w*|engineer\w*)|(web|mobile|application|app|android|ios|python|java|php|wordpress|react|angular|laravel|mern|mean|dotnet|c#) (develop\w*|engineer\w*)|mern stack|mean stack|\.net|robotic process automation|rpa|integration engineer\w*)\b/i],
 cloud: ['Cloud & DevOps', /\b(cloud|devops|dev ops|devsecops|site reliability|sre|sysops|techops|aws|azure|kubernetes)\b/i],
 database: ['Database engineering', /\b(database|dba|sql (developer|engineer|administrator))\b/i],
 security: ['Cyber security', /\b(cyber ?security|information security|network security|security operations|soc|penetration test\w*|pentest\w*|digital forensics|vulnerability|incident response|devsecops|data (protection|privacy)|iso 27001|platform security|cloud security)\b/i],
 network: ['Systems & networking', /\b(network|networking|systems? engineer\w*|systems? admin\w*|infrastructure|telecom\w*|data cent(er|re)|virtualization|iot)\b/i],
 support: ['IT & application support', /\b((it|ict|technical|application|desktop|technology|system|systems|erp) support|support engineer\w*|it service|business central support|microsoft 365|active directory|erp|sap)\b/i],
 business: ['Business & systems analysis', /\b(business analy\w*|systems? analy\w*|requirements engineer\w*|business system|functional consultant)\b/i],
 project: ['Project coordination', /\b(project (manager|management|coordinator|coordination)|scrum|product owner)\b/i],
 qa: ['Software testing & QA', /\b(software (test\w*|quality)|qa|quality (engineer\w*|assurance)|test automation|playwright|selenium|sdet)\b/i],
 ux: ['UI/UX & interaction', /\b(ui|ux|user experience|user interface|interaction design\w*)\b/i],
 media: ['Creative & interactive media', /\b(graphic\w*|digital artist|motion (graphic\w*|design\w*)|video|audio engineer\w*|game develop\w*|unity|unreal|ar vr|creative (design\w*|technolog\w*)|digital marketing|digital content|social media|seo)\b/i],
};
export const FIELDS = [
 ['data-science','Data Science','data ai software cloud database'],
 ['software-engineering','Software Engineering','software ai cloud data qa'],
 ['artificial-intelligence','Artificial Intelligence','ai data software cloud database'],
 ['cyber-security','Cyber Security','security'],
 ['systems-networking','Computer Systems & Networking','network cloud security support'],
 ['information-systems','Information Systems Engineering','business project data database support qa ux cloud security'],
 ['information-technology','Information Technology','software data ai qa network database cloud ux business project support'],
 ['interactive-media','Interactive Media','ux media webmedia'],
].map(([id,label,topics])=>({id,label,topics:topics.split(' ')}));
export const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015_/-]+/g,' ').replace(/\s+/g,' ').trim();
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function phraseMatch(title, phrase) {
 return new RegExp('(?:^|[^a-z0-9])'+escape(normalize(phrase))+'(?:s|es|ing|er|ers)?(?:$|[^a-z0-9])','i').test(normalize(title));
}
export function classifyTitle(title) {
 const text=normalize(title);
 const labels=Object.entries(TOPICS).filter(([, [,re]])=>re.test(text)).map(([id])=>id);
 // A sales/marketing role mentioning AI, software or ERP is not engineering.
 const commercial=/\b(sales|marketing|recruit\w*|illustration|video|content|customer service)\b/.test(text);
 if(commercial) {
   for(const id of ['ai','software','cloud','support']) { const i=labels.indexOf(id);if(i>=0)labels.splice(i,1); }
 }
 if(/\b(apparel|garment|textile|food|laboratory|regulatory|manufactur\w*)\b/.test(text)) {
   const i=labels.indexOf('qa');if(i>=0)labels.splice(i,1);
 }
 // Only interpret FE/BE/BA abbreviations in explicitly technical multi-role ads.
 if(/\bit internship opportunities\b/.test(text)) {
   if(/\b(fe|be)\b/.test(text))labels.push('software');
   if(/\bba\b/.test(text))labels.push('business');
 }
 if(/\bpm\s*&\s*ba\b/.test(text))labels.push('project','business');
 const uncertain=/\b(it intern\w*|intern\w* (in )?(it|information technology)|management trainee it|qa intern\w*|intern qa|quality assurance)\b/.test(text)
   && !/\b(software|playwright|selenium|engineer\w*|crm)\b/.test(text)
   && !labels.some(id=>id!=='qa')
   && !/\b(regulatory|facilities|accountancy|food|garment|apparel|manufactur\w*)\b/.test(text);
 return {topics:[...new Set(labels)],uncertain};
}
export function preferenceFor(sub) {
 return sub.emailPreferences || (sub.emailPack ? {mode:'selected',fields:[sub.emailPack],include:[],exclude:[],includeUncertain:false,name:''} : {mode:'all',fields:[],include:[],exclude:[],includeUncertain:false,name:''});
}
export function matchPreference(job,pref) {
 const title=typeof job==='string'?job:job.title;
 const excluded=(pref.exclude||[]).find(p=>phraseMatch(title,p));
 if(excluded)return {matches:false,reason:'Excluded phrase: '+excluded};
 if(pref.mode==='all')return {matches:true,reason:'All collected jobs'};
 const included=(pref.include||[]).find(p=>phraseMatch(title,p));
 if(included)return {matches:true,reason:'Custom phrase: '+included};
 const classified=classifyTitle(title);
 if(classified.uncertain && !pref.includeUncertain)return {matches:false,reason:'Ambiguous title; enable uncertain roles to include'};
 if(classified.uncertain && pref.includeUncertain)return {matches:true,reason:'Uncertain technical role (opted in)'};
 for(const field of FIELDS.filter(f=>(pref.fields||[]).includes(f.id))) {
   const topic=field.topics.find(t=>classified.topics.includes(t));
   if(topic)return {matches:true,reason:field.label+' · '+TOPICS[topic][0]};
 }
 return {matches:false,reason:'No selected field or phrase matched'};
}
export function passesPreferences(job,sub) {
 if(!sub.emailPreferences)return passesPack(typeof job==='string'?job:job.title,sub.emailPack);
 return matchPreference(job,sub.emailPreferences).matches;
}
export function parsePreference(body) {
 const mode=body.mode;
 if(!['all','selected'].includes(mode))throw Error('Choose all jobs or selected interests.');
 const fields=body.fields===undefined?[]:(Array.isArray(body.fields)?body.fields:[body.fields]);
 if(fields.length>8 || fields.some(id=>typeof id!=='string'||!FIELDS.some(f=>f.id===id)))throw Error('Choose a valid field.');
 const phrases=key=>{
   if(body[key]!==undefined && typeof body[key]!=='string')throw Error('Enter phrases as text.');
   const value=body[key]||'';if(value.length>1200)throw Error('Keep each phrase list under 1,200 characters.');
   const list=[...new Set(value.split(/[,\n]/).map(normalize).filter(Boolean))];
   if(list.length>20||list.some(p=>p.length<2||p.length>80))throw Error('Use up to 20 phrases, each 2–80 characters.');
   return list;
 };
 const include=phrases('include'),exclude=phrases('exclude');
 const name=typeof body.name==='string'?body.name.trim():'';
 if(name.length>60)throw Error('Keep the filter name under 60 characters.');
 if(mode==='selected'&&!fields.length&&!include.length)throw Error('Select a field or add an include phrase.');
 return {mode,fields:[...new Set(fields)],include,exclude,name,includeUncertain:body.includeUncertain==='on'};
}
