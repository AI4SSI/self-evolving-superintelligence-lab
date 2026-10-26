import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await rm(root+'dist',{recursive:true,force:true});
await mkdir(root+'dist',{recursive:true});
for(const file of ['index.html','styles.css','app.js','.nojekyll'])await copyFile(root+file,root+'dist/'+file);
await cp(root+'assets',root+'dist/assets',{recursive:true});
console.log('Built static website in dist/ (public website assets only).');
