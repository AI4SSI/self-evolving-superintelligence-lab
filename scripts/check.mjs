import {readFile,stat,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=fileURLToPath(new URL('../',import.meta.url));
const html=await readFile(root+'index.html','utf8');
const css=await readFile(root+'styles.css','utf8');
const js=await readFile(root+'app.js','utf8');
const errors=[];
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
if(ids.length!==new Set(ids).size)errors.push('Duplicate HTML IDs');
for(const m of html.matchAll(/(?:src|href|poster)="([^"]+)"/g)){
 const value=m[1];if(value.startsWith('#')){if(!ids.includes(value.slice(1)))errors.push('Missing anchor '+value);}
 else if(!/^https?:/.test(value)){if(value.startsWith('/'))errors.push('Root-relative URL breaks project Pages: '+value);try{await stat(root+value);}catch{errors.push('Missing asset '+value);}}
}
for(const m of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)){try{await stat(root+m[1]);}catch{errors.push('Missing CSS asset '+m[1]);}}
if((html.match(/<video\b/g)||[]).length!==3)errors.push('Expected three video players');
if((html.match(/class="annotation-toggle"/g)||[]).length!==3)errors.push('Expected annotations on all three players');
if(/psl-uillinois|Unknown|lorem ipsum/i.test(html))errors.push('Stale hosting or placeholder content');
if(!html.includes('https://ai4ssi.github.io/self-evolving-superintelligence-lab/'))errors.push('Missing AI4SSI canonical URL');
new vm.Script(js);
for(const file of await readdir(root+'assets')){const s=await stat(root+'assets/'+file);if(s.size>95*1024*1024)errors.push('Asset too large for ordinary Git: '+file);}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log('Checks passed: relative assets, section links, three annotated videos, AI4SSI hosting metadata, and JavaScript syntax.');
