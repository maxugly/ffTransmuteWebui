import { state } from '/app.js?v=2';

const oneShotTabs=new Set(['music','txt2img','img2img','rife','rife-recohere','facemorph','withoutbg','upscale']);
let hotStatus=null,changing=false,activity=null,lastPoll=0;
const duration=value=>{const s=Math.max(0,Math.round(value));return s>=60?`${Math.floor(s/60)}m ${s%60}s`:`${s}s`;};

function paintHot(){
 const button=document.getElementById('btnModelHot');if(!button||!hotStatus)return;
 button.setAttribute('aria-pressed',String(hotStatus.enabled));
 const n=hotStatus.resident.length;
 button.textContent=`♨ Models hot: ${hotStatus.enabled?'On':'Off'}${n?` · ${n}`:''}`;
 button.dataset.helpText=`${hotStatus.enabled?'Retain supported models between runs.':'Release supported models after each run.'} ${hotStatus.release_pending?'Release waits for the current job to finish. ':''}Resident: ${hotStatus.resident.map(r=>r.engine+(r.model?' / '+r.model:'')).join(', ')||'none yet'}. Supported: ${hotStatus.supported.join('; ')}. One-shot: ${hotStatus.one_shot.join(', ')}.${oneShotTabs.has(state.activeTab)?' This tab uses an external one-shot engine.':''}`;
 button.disabled=changing;
 const setting=document.getElementById('settingsKeepModelsHot');if(setting)setting.checked=hotStatus.enabled;
 // Replaced by the shared header policy, rather than leaving conflicting switches.
 for(const id of ['dreamWarm','stWarm','fastsamWarm'])document.getElementById(id)?.closest('.knob-bank')?.setAttribute('hidden','');
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

async function change(value){
 if(changing)return;changing=true;paintHot();
 try{
  const response=await fetch('/api/models/hot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:value})});const data=await response.json();if(!data.ok)throw Error(data.error);
  hotStatus=data;state.settings.keepModelsHot=data.enabled;localStorage.setItem('mtapi.settings',JSON.stringify(state.settings));
 }catch(error){document.getElementById('statusText').textContent=error.message;}
 finally{changing=false;paintHot();}
}

async function poll(){
 try{
  const results=await Promise.all([fetch('/api/models/hot').then(r=>r.json()),fetch('/api/activity').then(r=>r.json())]);
  if(results[0].ok&&!changing){hotStatus=results[0];state.settings.keepModelsHot=hotStatus.enabled;paintHot();}
  if(results[1].ok){activity=results[1];lastPoll=Date.now();paintActivity();}
 }catch{document.getElementById('statusText').textContent='Offline';document.getElementById('statusDot').className='status-dot error';}
 setTimeout(poll,1000);
}

export function initModelHot(){
 document.getElementById('btnModelHot')?.addEventListener('click',()=>change(!hotStatus?.enabled));
 document.addEventListener('change',event=>{if(event.target.id==='settingsKeepModelsHot')change(event.target.checked);});
 setInterval(()=>{paintHot();paintActivity();},500);
 poll();
}
