/* Browser workbench built on the research twin's CAD renderer. State stays in this browser. */
const BENCH = [1220, 610];
const KEY = 'sesl-digital-twin-layout-v1';
const PROFILE = {
  piper: {name:'PiPER arm', kind:'module', color:'#708aaa', size:[526.65,145,513.02], origin:[218.33,0,0], model:'models/piper.glb', description:'Articulated robot arm'},
  bunny: {name:'Weighing Bunny', kind:'module', color:'#9b7bad', size:[190,378.93,380.3], origin:[0,-4.09,-30.76], model:'models/bunny.glb', description:'Weighing module'},
  beaker: {name:'50 mL beaker', kind:'container', color:'#7bb6c5', size:[50.42,45.5,53], origin:[2.46,0,0], model:'models/beaker.glb', description:'Laboratory vessel'}
};
const $ = selector => document.querySelector(selector);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const defaults = () => ({version:1,items:[
  {id:'piper-1',type:'piper',x:850,y:305,rot:180,joints:{j1:0,j2:0,j3:-90,gripper:20}},
  {id:'bunny-1',type:'bunny',x:240,y:305,rot:0,joints:{}},
  {id:'beaker-1',type:'beaker',x:500,y:160,rot:0,joints:{}}
]});
let state = defaults();
let selectedId = 'piper-1';
let ready = false;
let frame = 0;
let playing = false;
let startJoints = null;
const kin = {};

function announce(message) { $('#status').textContent = message; }
function current() { return state.items.find(item => item.id === selectedId) || null; }
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { announce('Layout changed. Browser storage is unavailable; use Export JSON to keep it.'); } }
function sanitized(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.items) || input.items.length > 24) throw Error('Choose a version 1 layout with no more than 24 objects.');
  const used = new Set();
  const items = input.items.map((raw, index) => {
    if (!raw || !Object.hasOwn(PROFILE, raw.type)) throw Error('The layout contains an unknown object type.');
    if (![raw.x,raw.y,raw.rot].every(Number.isFinite)) throw Error('Object coordinates must be numbers.');
    const id = typeof raw.id === 'string' && /^[a-z0-9-]{1,36}$/i.test(raw.id) && !used.has(raw.id) ? raw.id : `${raw.type}-${index+1}`;
    if (used.has(id)) throw Error('The layout contains duplicate object identifiers.');
    used.add(id);
    const joints = {};
    if (raw.joints && typeof raw.joints === 'object') for (const [key,value] of Object.entries(raw.joints)) {
      if (/^(j[1-6]|gripper|[a-z_]{1,20})$/.test(key) && Number.isFinite(value)) joints[key] = clamp(value,-360,360);
    }
    return {id,type:raw.type,x:clamp(Math.round(raw.x),0,BENCH[0]),y:clamp(Math.round(raw.y),0,BENCH[1]),rot:((Math.round(raw.rot)%360)+360)%360,joints};
  });
  if (!items.length) throw Error('The layout needs at least one object.');
  return {version:1,items};
}
function restore() {
  try { const saved=localStorage.getItem(KEY); if(saved) state=sanitized(JSON.parse(saved)); }
  catch { state=defaults(); }
  if(!state.items.some(item=>item.id===selectedId)) selectedId=state.items[0].id;
}
function sceneDescription() {
  return {bench:BENCH,name:'Virtual laboratory',items:state.items.map(item=>{
    const spec=PROFILE[item.type];
    return {id:item.id,label:spec.name,sub:item.id,kind:spec.kind,x:item.x,y:item.y,z:0,rot:item.rot,size:spec.size,model:{url:spec.model,origin:spec.origin},kinematics:kin[item.type]||null,joints:item.joints,reach:item.type==='piper'?400:0};
  }),arrows:[]};
}
function renderScene() { if(ready) { window.TW3D.render(sceneDescription());window.TW3D.setSelected(selectedId); } }
function showFallback() { const fallback=$('.scene-fallback'); fallback.hidden=false;announce('3D graphics are unavailable. Position controls and JSON export still work.'); }
function renderList() {
  const list=$('#object-list');list.replaceChildren();
  state.items.forEach(item=>{
    const button=document.createElement('button');button.type='button';button.dataset.id=item.id;
    button.setAttribute('aria-pressed',String(item.id===selectedId));
    const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=PROFILE[item.type].color;
    const label=document.createElement('span');label.className='object-name';label.textContent=PROFILE[item.type].name;
    const sub=document.createElement('span');sub.className='object-sub';sub.textContent=item.id;
    const stack=document.createElement('span');stack.append(label,sub);button.append(swatch,stack);
    button.addEventListener('click',()=>select(item.id));list.append(button);
  });
  $('#object-count').textContent=`${state.items.length} object${state.items.length===1?'':'s'}`;
}
function drawJoints(item) {
  const wrap=$('#joint-controls');wrap.replaceChildren();
  const panel=$('#joint-details');panel.hidden=!item || item.type!=='piper' || !kin.piper;
  if(panel.hidden)return;
  const names={j1:'Base yaw',j2:'Shoulder',j3:'Elbow',j4:'Wrist roll',j5:'Wrist pitch',j6:'Tool roll',gripper:'Gripper opening'};
  for(const link of kin.piper.links){
    const j=link.joint;if(!j||j.mimic)continue;
    const row=document.createElement('label');row.className='joint-row';
    const head=document.createElement('div');const name=document.createElement('span');name.textContent=names[j.id]||j.id;
    const output=document.createElement('output');output.textContent=String(item.joints[j.id]??j.modelled??0)+(j.type==='prismatic'?' mm':'°');
    head.append(name,output);
    const range=document.createElement('input');range.type='range';range.min=String(Math.min(...j.range));range.max=String(Math.max(...j.range));range.step='any';range.value=String(clamp(item.joints[j.id]??j.modelled??0,+range.min,+range.max));range.setAttribute('aria-label',name.textContent);
    range.addEventListener('input',()=>{
      if(playing)stopMotion();
      item.joints[j.id]=Number(range.value);output.textContent=range.value+(j.type==='prismatic'?' mm':'°');
      if(ready)window.TW3D.applyPose([{id:item.id,joints:item.joints}]);persist();
      announce(`${names[j.id]||j.id} set to ${range.value}.`);
    });
    row.append(head,range);wrap.append(row);
  }
}
function updateInspector() {
  const item=current();
  $('#selected-name').textContent=item?PROFILE[item.type].name:'No object selected';
  $('#selected-type').textContent=item?item.type.toUpperCase():'';
  for(const [field,value] of [['#position-x',item?.x],['#position-y',item?.y],['#position-rot',item?.rot]]){const input=$(field);input.disabled=!item;input.value=value??'';}
  $('#apply-position').disabled=!item;
  $('#remove-item').disabled=!item;
  drawJoints(item);
  [...$('#object-list').children].forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.id===selectedId)));
}
function select(id) {
  selectedId=state.items.some(item=>item.id===id)?id:null;
  if(ready)window.TW3D.setSelected(selectedId);
  updateInspector();
  if(selectedId)announce(`${PROFILE[current().type].name} selected. Drag it in the scene or edit its position.`);
}
function move(id,x,y,extra={}) {
  const item=state.items.find(p=>p.id===id);if(!item)return;
  item.x=clamp(Math.round(x),0,BENCH[0]);item.y=clamp(Math.round(y),0,BENCH[1]);
  if(Number.isFinite(extra.z))item.z=clamp(Math.round(extra.z),0,500);
  if(ready)window.TW3D.applyPose([{id:item.id,x:item.x,y:item.y,z:item.z||0,rot:item.rot}]);
  selectedId=id;updateInspector();persist();announce(`${PROFILE[item.type].name} moved to X ${item.x}, Y ${item.y} mm.`);
}
function applyPosition() {
  const item=current();if(!item)return;
  const x=Number($('#position-x').value),y=Number($('#position-y').value),r=Number($('#position-rot').value);
  if(![x,y,r].every(Number.isFinite)){announce('Enter numeric coordinates and rotation.');return;}
  item.rot=((Math.round(r)%360)+360)%360;move(item.id,x,y);
}
function addItem() {
  const type=$('#part-type').value;if(!Object.hasOwn(PROFILE,type))return;
  if(state.items.length>=24){announce('This browser workbench supports up to 24 objects.');return;}
  let n=1;while(state.items.some(item=>item.id===`${type}-${n}`))n++;
  const item={id:`${type}-${n}`,type,x:type==='piper'?780:type==='bunny'?250:440+n*38,y:type==='beaker'?140+n*25:300,rot:type==='piper'?180:0,joints:type==='piper'?{j1:0,j2:0,j3:-90,gripper:20}:{}};
  state.items.push(item);selectedId=item.id;renderList();renderScene();updateInspector();persist();announce(`${PROFILE[type].name} added. Drag it into place.`);
}
function removeItem() {
  const item=current();if(!item)return;
  if(playing)stopMotion();
  state.items=state.items.filter(i=>i.id!==item.id);
  if(!state.items.length){state=defaults();announce('The bench was reset to its starting equipment.');}
  selectedId=state.items[0].id;renderList();renderScene();updateInspector();persist();
}
function stopMotion() {
  if(frame)cancelAnimationFrame(frame);frame=0;playing=false;
  const arm=state.items.find(item=>item.type==='piper');
  if(arm&&startJoints){arm.joints={...startJoints};if(ready)window.TW3D.applyPose([{id:arm.id,joints:arm.joints}]);if(selectedId===arm.id)drawJoints(arm);startJoints=null;}
  $('#play-motion').disabled=false;$('#stop-motion').disabled=true;
  announce('Motion preview stopped.');
}
function playMotion() {
  const arm=state.items.find(item=>item.type==='piper');
  if(!arm){announce('Add a PiPER arm to preview its motion.');return;}
  if(!ready){announce('3D graphics are needed for motion preview.');return;}
  if(playing)stopMotion();
  selectedId=arm.id;updateInspector();window.TW3D.setSelected(arm.id);
  startJoints={...arm.joints};playing=true;$('#play-motion').disabled=true;$('#stop-motion').disabled=false;
  let began=null;
  function step(now){
    if(!playing)return;
    if(began===null)began=now;
    const t=clamp((now-began)/3500,0,1);
    const wave=Math.sin(Math.PI*t),swing=Math.sin(2*Math.PI*t);
    arm.joints.j1=(startJoints.j1||0)+25*swing;
    arm.joints.j2=(startJoints.j2||0)+18*wave;
    arm.joints.j3=(startJoints.j3??-90)-25*wave;
    arm.joints.gripper=(startJoints.gripper??20)+18*wave;
    window.TW3D.applyPose([{id:arm.id,joints:arm.joints}]);
    if(t<1){announce(`Simulating arm motion · ${Math.round(t*100)}%`);frame=requestAnimationFrame(step);}
    else {arm.joints={...startJoints};startJoints=null;window.TW3D.applyPose([{id:arm.id,joints:arm.joints}]);playing=false;frame=0;$('#play-motion').disabled=false;$('#stop-motion').disabled=true;drawJoints(arm);announce('Motion preview complete. Arm returned to its starting pose.');}
  }
  frame=requestAnimationFrame(step);
}
function exportLayout() {
  const blob=new Blob([JSON.stringify({...state,bench_mm:BENCH},null,2)+'\n'],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='digital-twin-layout.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);announce('Layout exported as JSON.');
}
async function importLayout(file) {
  try {if(file.size>100000)throw Error('Layout file is too large.');const imported=sanitized(JSON.parse(await file.text()));stopMotion();state=imported;selectedId=state.items[0].id;renderList();renderScene();updateInspector();persist();announce(`Imported ${state.items.length} objects.`);}
  catch(error){announce(`Could not import layout: ${error.message}`);}
  $('#import-layout').value='';
}
function reset() {stopMotion();state=defaults();selectedId=state.items[0].id;renderList();renderScene();updateInspector();persist();announce('Default bench layout restored.');}
async function start() {
  if(start.done)return;start.done=true;
  try {
    const responses=await Promise.all(['piper','bunny'].map(name=>fetch(`${name}-kinematics.json`)));
    if(responses.some(r=>!r.ok))throw Error('Model configuration could not load.');
    [kin.piper,kin.bunny]=await Promise.all(responses.map(r=>r.json()));
  }catch(error){announce(error.message);return;}
  restore();renderList();updateInspector();
  try {window.TW3D.mount($('#twin-view'),{onSelect:select,onMove:move});ready=true;renderScene();announce('Digital twin ready. Drag equipment, adjust robot joints, or play a motion preview.');}
  catch(error){showFallback();}
  $('#fit-view').addEventListener('click',()=>{if(ready)window.TW3D.fit();});
  $('#add-item').addEventListener('click',addItem);
  $('#apply-position').addEventListener('click',applyPosition);
  for(const id of ['#position-x','#position-y','#position-rot'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter')applyPosition();});
  $('#remove-item').addEventListener('click',removeItem);
  $('#play-motion').addEventListener('click',playMotion);
  $('#stop-motion').addEventListener('click',stopMotion);
  $('#save-layout').addEventListener('click',()=>{persist();announce('Layout saved in this browser.');});
  $('#export-layout').addEventListener('click',exportLayout);
  $('#import-layout').addEventListener('change',event=>{if(event.target.files[0])importLayout(event.target.files[0]);});
  $('#reset-layout').addEventListener('click',reset);
}
if(window.TW3D)start();else window.addEventListener('tw3d-ready',start,{once:true});
