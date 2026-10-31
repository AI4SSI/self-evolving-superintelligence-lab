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
if((html.match(/<video\b/g)||[]).length!==4)errors.push('Expected four video players');
if((html.match(/class="annotation-toggle"/g)||[]).length!==2)errors.push('Expected toggles on both supporting video overlays');
if(!html.includes('Scientific Superintelligence')&&!html.includes('Scientific_Superintelligence'))errors.push('Expected annotated main video');
if(!html.includes('assets/recognize_bunny-3x.mp4')||!html.includes('featured-film-rail'))errors.push('Missing featured recognition video rail');
if(html.indexOf('assets/recognize_bunny-3x.mp4')<html.indexOf('assets/scientific-superintelligence-annotated.mp4'))errors.push('Recognition video must be on the right');
if(!html.includes('assets/overview-fume-hood.png')||!html.includes('assets/render-main-final.png'))errors.push('Missing requested setup images');
if((html.match(/<sup>†<\/sup>/g)||[]).length!==3||!html.includes('† Co-first authors'))errors.push('Missing co-first author marks');
if(!html.includes('<p class="author-row">Mohamed Eshan · Olamide Ogunjobi · Owen Funke · Yu Liu · Yuxing Wang'))errors.push('Missing second author row');
for(const institution of ['UIUC','CMU','Northeastern','NVIDIA'])if(!html.includes(institution))errors.push('Missing institution '+institution);
if(/Evernovum/i.test(html))errors.push('Removed institution remains on page');
for(const author of ['Renjie Li','Yuanhao Zhou','Yinqi Zeng','Edward Lukhanin','Huan Liu','Carter McNear','Daniel Ceballos','Mohamed Eshan','Olamide Ogunjobi','Owen Funke','Yu Liu','Yuxing Wang','Paul Braun','Lynford Goddard'])if(!html.includes(author))errors.push('Missing author '+author);
if(html.includes('https://github.com/AI4SSI/self-evolving-superintelligence-lab'))errors.push('Remove project repository link from the page');
if(!html.includes('digital-twin/index.html'))errors.push('Missing digital twin module');
if(/psl-uillinois|Unknown|lorem ipsum/i.test(html))errors.push('Stale hosting or placeholder content');
if(!html.includes('https://ai4ssi.github.io/self-evolving-superintelligence-lab/'))errors.push('Missing AI4SSI canonical URL');
new vm.Script(js);
const twin=await readFile(root+'digital-twin/index.html','utf8');
const twinJs=await readFile(root+'digital-twin/workbench.js','utf8');
new vm.Script(twinJs);
for(const ref of ['twin3d.js','workbench.js','models/piper.glb','models/bunny.glb','models/beaker.glb','vendor/three.module.js']){try{await stat(root+'digital-twin/'+ref)}catch{errors.push('Missing twin asset '+ref)}}
if(!twin.includes('workbench.js'))errors.push('Digital twin controller is not loaded');
for(const file of await readdir(root+'assets')){const s=await stat(root+'assets/'+file);if(s.size>95*1024*1024)errors.push('Asset too large for ordinary Git: '+file);}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log('Checks passed: relative assets, section links, annotated media, digital twin assets, AI4SSI hosting metadata, and JavaScript syntax.');
