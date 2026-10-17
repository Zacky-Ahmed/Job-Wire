import {readFileSync,writeFileSync} from 'node:fs';
import {FIELDS,classifyTitle,matchPreference} from '../src/services/emailPreferences.js';
const rows=JSON.parse(readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
const titles=[...new Set(rows.map(r=>r.title))];
const report={records:rows.length,uniqueTitles:titles.length,withDescriptions:rows.filter(r=>r.description).length,uncertainTitles:titles.filter(t=>classifyTitle(t).uncertain),fields:FIELDS.map(f=>({field:f.label,allDatabaseRecords:rows.filter(j=>matchPreference(j,{mode:'selected',fields:[f.id]}).matches).length,matchedFeedRecords:rows.filter(j=>j.matched!==false&&matchPreference(j,{mode:'selected',fields:[f.id]}).matches).length,examples:titles.filter(t=>matchPreference(t,{mode:'selected',fields:[f.id]}).matches).slice(0,12)}))};
writeFileSync(process.argv[3],JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
