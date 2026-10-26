const systems={
  dry:{label:'DRY EVOLVES',color:'#3f6a96',text:'Code, simulations, datasets, and the digital twin improve as experimental evidence reveals where predictions and procedures fall short.',receives:'measurements + model proposals',returns:'testable plans + validated digital tools'},
  wet:{label:'WET EVOLVES',color:'#ae613d',text:'Wet-lab experiments, chemistry synthesis, robotic manipulation, and 3D printing generate physical evidence. Reviewed workflow changes can improve how the next experiment is performed.',receives:'reviewed hypotheses + executable plans',returns:'materials + experimental observations'},
  model:{label:'MODEL EVOLVES',color:'#79609b',text:'Large-scale language and vision-language models can improve through curated evidence, evaluation, and domain-specific refinement, informing scientific reasoning and experimental design.',receives:'curated data + evaluated outcomes',returns:'hypotheses + workflow proposals'}
};
const tabs=[...document.querySelectorAll('[data-system]')];
const panel=document.querySelector('#system-detail');
function selectSystem(tab){
  tabs.forEach(t=>{t.setAttribute('aria-selected',String(t===tab));t.tabIndex=t===tab?0:-1;});
  const s=systems[tab.dataset.system];
  panel.setAttribute('aria-labelledby',tab.id);
  panel.querySelector('.detail-label').textContent=s.label;
  panel.querySelector('.detail-label').style.color=s.color;
  panel.querySelector('p').textContent=s.text;
  panel.querySelector('div').replaceChildren(...['Receives: '+s.receives,'Returns: '+s.returns].map(text=>{const el=document.createElement('span');el.textContent=text;return el;}));
}
tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectSystem(tab));tab.addEventListener('keydown',event=>{let n;if(event.key==='ArrowRight')n=(i+1)%tabs.length;if(event.key==='ArrowLeft')n=(i+tabs.length-1)%tabs.length;if(event.key==='Home')n=0;if(event.key==='End')n=tabs.length-1;if(n!==undefined){event.preventDefault();selectSystem(tabs[n]);tabs[n].focus();}});});
document.querySelectorAll('.annotation-toggle').forEach(button=>button.addEventListener('click',()=>{const shown=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(shown));button.querySelector('span').textContent=shown?'ON':'OFF';button.closest('.video-shell').classList.toggle('annotations-hidden',!shown);}));
const mainVideo=document.querySelector('#main-video');
mainVideo.defaultPlaybackRate=2;
mainVideo.playbackRate=2;
const playButton=document.querySelector('#main-play');
const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
if(motion.matches){mainVideo.autoplay=false;mainVideo.pause();}
function updatePlay(){playButton.replaceChildren(document.createTextNode(mainVideo.paused?'Play video ':'Pause video '));const icon=document.createElement('span');icon.ariaHidden='true';icon.textContent=mainVideo.paused?'▷':'Ⅱ';playButton.append(icon);}
mainVideo.addEventListener('play',updatePlay);mainVideo.addEventListener('pause',updatePlay);updatePlay();
playButton.addEventListener('click',()=>{if(mainVideo.paused){mainVideo.play().catch(()=>updatePlay());}else mainVideo.pause();});
document.querySelectorAll('video').forEach(video=>video.addEventListener('play',()=>{document.querySelectorAll('video').forEach(other=>{if(other!==video)other.pause();});}));
const rail=document.querySelector('#film-rail');
const prev=document.querySelector('#video-prev');
const next=document.querySelector('#video-next');
const dots=[...document.querySelectorAll('.rail-dot')];
function moveRail(direction){const card=rail.querySelector('figure');rail.scrollBy({left:direction*(card.offsetWidth+parseFloat(getComputedStyle(rail).gap)),behavior:motion.matches?'instant':'smooth'});}
prev.addEventListener('click',()=>moveRail(-1));next.addEventListener('click',()=>moveRail(1));
rail.addEventListener('keydown',e=>{if(e.target!==rail)return;if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();moveRail(e.key==='ArrowRight'?1:-1);}});
function updateRail(){const remaining=rail.scrollWidth-rail.clientWidth;prev.disabled=rail.scrollLeft<8;next.disabled=rail.scrollLeft>=remaining-8;dots.forEach((d,i)=>d.classList.toggle('active',i===(rail.scrollLeft>remaining/2?1:0)));}
rail.addEventListener('scroll',updateRail,{passive:true});window.addEventListener('resize',updateRail);updateRail();
const chapterLinks=[...document.querySelectorAll('.contents nav a')];
const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting)chapterLinks.forEach(a=>a.classList.toggle('active',a.hash==='#'+entry.target.id));});},{rootMargin:'-5% 0px -65% 0px'});
document.querySelectorAll('.chapter').forEach(s=>observer.observe(s));
const imageDialog=document.querySelector('.image-dialog');
document.querySelectorAll('.setup-image').forEach(button=>button.addEventListener('click',()=>{imageDialog.querySelector('img').src=button.dataset.image;imageDialog.querySelector('img').alt=button.querySelector('img').alt;imageDialog.querySelector('p').textContent=button.dataset.caption;imageDialog.showModal();}));
imageDialog.querySelector('.dialog-close').addEventListener('click',()=>imageDialog.close());
imageDialog.addEventListener('click',event=>{if(event.target===imageDialog)imageDialog.close();});
