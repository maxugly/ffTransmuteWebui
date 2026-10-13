import { state } from '/app.js?v=2';

let hotStatus=null, changing=false, activity=null, lastPoll=0, selectedSignature='', inFlight=false, pendingChange=null;
const duration=value=>{const s=Math.max(0,Math.round(value));return s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`;};
const value=id=>document.getElementById(id)?.value||'';
const setText=(el,text)=>{if(el && el.textContent!==text)el.textContent=text;};
const size=bytes=>bytes==null?'size unavailable':bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GiB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} MiB`:`${bytes} B`;
const selectors={
 tts:{model:'ttsModel',voice:'ttsVoice',quality:'ttsQuality'},
 deepdream:{model:'dreamModel',engine:'dreamEngine'},styletransfer:{engine:'stEngine'},
 fastsam:{model:'fastsamModel'},demucs:{model:'dmModel'},withoutbg:{engine:'wbgBackend'},
 airapper:{model:'arModel'},imagesort:{model:'isRifeModel'},music:{model:'muModel',lora:'muLora'},txt2img:{model:'t2iModel'},img2img:{model:'i2iModel'},
 rife:{model:'rifeModel'},riferecohere:{model:'rrRifeModel',auxiliary:'rrModel'},speedchange:{model:'usRifeModel'},
 qr_art:{model:'qrModel'},upscale:{engine:'upEngine',model:'upModel'},
};
function query(){
 const params=new URLSearchParams({tab:state.activeTab});
 for(const [name,id] of Object.entries(selectors[state.activeTab]||{}))params.set(name,value(id));
 return params.toString();
}
const belongs=(entry,tab)=>entry.tool===tab||entry.tabs?.includes(tab)||(tab==='airapper'&&entry.tool==='music');
export function residencyState(snapshot,tab,global=false){
 if(!snapshot)return 'unknown';
 if(snapshot.loading.some(r=>global||belongs(r,tab)))return 'loading';
 if(snapshot.resident.some(r=>belongs(r,tab)))return 'loaded';
 return snapshot.resident.length?'elsewhere':'empty';
}
const names=entries=>[...new Set(entries.map(r=>`${r.engine}${r.model?' / '+r.model:''}`))].join('; ');

function mountPanel(){
 const host=document.getElementById('actionPanelForm');
 if(!host)return null;
 let panel=document.getElementById('modelTabStatus');
 if(!hotStatus?.tabs[state.activeTab]){if(panel)panel.hidden=true;return null;}
 if(!panel){
  panel=document.createElement('div');panel.id='modelTabStatus';panel.className='model-tab-status';
  panel.innerHTML=`<span class="model-local-state" id="modelLocalState" role="status"><span class="model-state-dot" aria-hidden="true"></span><span id="modelLocalText"></span></span><span id="modelDiskSize"></span><label id="modelKeepLabel" data-help-title="Keep this tool’s model loaded" data-help-text="Retain this tool’s model after a run. Turning this off releases only this tool’s retained model after active jobs finish. It never loads a model or changes another tool’s preference."><input id="modelKeepLoaded" type="checkbox"><span id="modelKeepText">Keep loaded</span></label><span id="modelLocalDetail" class="model-detail"></span>`;
  host.prepend(panel);
 }
 panel.hidden=false;panel.dataset.tool=state.activeTab;
 return panel;
}

function paintHot(){
 const global=document.getElementById('modelGlobalStatus');
 if(global){
  const color=residencyState(hotStatus,state.activeTab,true);
  global.dataset.state=color;
  const count=hotStatus?new Set(hotStatus.resident.map(r=>r.tool)).size:0;
  setText(document.getElementById('modelGlobalText'),color==='loading'?'Models · loading…':color==='loaded'?'Models · loaded for this tab':color==='elsewhere'?`Models · loaded elsewhere (${count})`:color==='empty'?'Models · none loaded':'Models · status unavailable');
  global.dataset.helpText=hotStatus?`Orange: nothing loaded. Red: loaded elsewhere. Green: loaded for this tab. Yellow: loading. Loaded: ${names(hotStatus.resident)||'none'}. Loading: ${names(hotStatus.loading)||'none'}. Navigation does not load or unload models.`:'Model status is unavailable; reconnecting.';
 }
 const panel=mountPanel();if(!panel)return;
 const tool=state.activeTab, tab=hotStatus.tabs[tool], color=residencyState(hotStatus,tool);
 const local=hotStatus.resident.filter(r=>belongs(r,tool)), loading=hotStatus.loading.filter(r=>belongs(r,tool));
 const current=selectedSignature===query()?hotStatus.selection:null;
 const localState=document.getElementById('modelLocalState');localState.dataset.state=color;
 setText(document.getElementById('modelLocalText'),color==='loading'?(tool==='facemorph'?'Loading / detecting landmarks…':'Loading model…'):color==='loaded'?'Loaded for this tab':color==='elsewhere'?'Not loaded here · models loaded elsewhere':'No models loaded');
 setText(document.getElementById('modelDiskSize'),current?`Selected: ${current.label} · ${size(current.disk_bytes)} on disk`:'Checking selected model size…');
 const supported=tab.retention_supported;
 document.getElementById('modelKeepLabel').dataset.helpText=supported?'Retain this tool’s model after use. Off releases only this tool’s model after active jobs finish. Navigation never loads or releases models.':'This engine currently exits after each run, so retention is unavailable. Its actual loading status and model files are shown here.';
 const checkbox=document.getElementById('modelKeepLoaded');
 checkbox.checked=pendingChange?.tool===tool?pendingChange.enabled:!!hotStatus.policies[tool];checkbox.disabled=changing||!supported;
 document.getElementById('modelKeepLabel').hidden=false;
 setText(document.getElementById('modelKeepText'),supported?'Keep loaded':'Keep loaded · unavailable');
 let detail=loading.length?`Loading: ${names(loading)}`:local.length?`Loaded: ${names(local)}`:'Model loads when you run this tool.';
 if(current?.native)detail+=' Selected native synthesizer has no neural checkpoint to retain.';
 else if(current?.remote)detail+=' Selected cloud engine has no local model.';
 else if(!supported)detail+=' One-shot engine · releases its model when the process exits.';
 if(hotStatus.release_pending.includes(tool))detail+=' Release waits for active jobs to finish.';
 setText(document.getElementById('modelLocalDetail'),detail);
 state.settings.warmModels={...(state.settings.warmModels||{}),...hotStatus.policies};
}

function paintActivity(){
 const text=document.getElementById('statusText'),dot=document.getElementById('statusDot');if(!text||!activity)return;
 const job=activity.live[0];
 if(job){
  const elapsed=(job.elapsed_s||0)+(Date.now()-lastPoll)/1000;
  const total=job.estimated_s;
  const eta=total!=null?(total>elapsed?`~${duration(total-elapsed)} left`:'Taking longer than estimated'):job.eta_s>0?`~${duration(job.eta_s)} left`:job.operation?.startsWith('tts_')?'ETA learning':'ETA unavailable';
  text.textContent=`${job.model_label||job.operation}\n${job.message||'Working…'}\n${duration(elapsed)} elapsed · ${eta}${job.word_count!=null?` · ${job.word_count} words`:''}${activity.live.length>1?`\n${activity.live.length} active jobs`:''}`;
  dot.className='status-dot loading';
 }else{
  const job=activity.recent[0];
  text.textContent=job?`${job.status==='done'?'Ready':'Job '+job.status} · ${job.operation}\n${job.message||job.status} · ${duration(job.elapsed_s||0)} elapsed`:'System Ready';
  dot.className=job&&['error','failed'].includes(job.status)?'status-dot error':'status-dot';
 }
}


async function change(tool,enabled){
 if(changing)return;
 changing=true;pendingChange={tool,enabled};paintHot();
 try{
  const response=await fetch('/api/models/hot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool,enabled})});
  const data=await response.json();if(!data.ok)throw Error(data.error);
  hotStatus=data;selectedSignature='';
  state.settings.warmModels={...(state.settings.warmModels||{}),...data.policies};
  localStorage.setItem('mtapi.settings',JSON.stringify(state.settings));
 }catch(error){setText(document.getElementById('statusText'),error.message);}
 finally{changing=false;pendingChange=null;paintHot();poll();}
}

async function poll(){
 if(inFlight)return;inFlight=true;
 const signature=query();
 try{
  const results=await Promise.all([fetch('/api/models/hot?'+signature).then(r=>r.json()),fetch('/api/activity').then(r=>r.json())]);
  if(results[0].ok&&!changing){hotStatus=results[0];selectedSignature=signature;paintHot();}
  else if(!results[0].ok)throw Error(results[0].error||'Model status unavailable');
  if(results[1].ok){activity=results[1];lastPoll=Date.now();paintActivity();}
 }catch{
  hotStatus=null;paintHot();
  setText(document.getElementById('statusText'),'Offline');document.getElementById('statusDot').className='status-dot error';
 }finally{inFlight=false;}
}

export function initModelHot(){
 document.addEventListener('change',event=>{
  if(event.target.id==='modelKeepLoaded')change(event.target.closest('[data-tool]').dataset.tool,event.target.checked);
  else if(Object.values(selectors[state.activeTab]||{}).includes(event.target.id))requestAnimationFrame(poll);
 });
 setInterval(()=>{paintHot();paintActivity();if(selectedSignature!==query())poll();},300);
 setInterval(poll,1000);
 poll();
}
