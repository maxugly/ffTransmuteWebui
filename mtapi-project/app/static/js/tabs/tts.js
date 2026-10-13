import { elements } from '/app.js?v=2';
import { escapeHtml as esc } from '/js/utils.js';
import { openAudioExportDialog } from '/js/ui/audio-export.js';

const KEY='mtapi.tts.preferences';
let prefs;
try { prefs=JSON.parse(localStorage.getItem(KEY)||'{}'); } catch { prefs={}; }
prefs={model:'piper-lessac',text:'',save:true,speaker:false,format:'flac',output:'',settings:{},voices:{},...prefs};
let catalog, running=null, previewId=null, renderSequence=0, lastGenerationJob=null, staleResult=false;
prefs.voices ||= {};
prefs.qualities ||= {};
prefs.synthesis ||= {};
prefs.controlsExpanded ||= {};
const autoPlayed = new Set();
let editRevision=0;
const generationRevisions=new Map();
let playbackAudio=null;
const stopPlayback=()=>{playbackAudio?.pause();};
const remember=()=>localStorage.setItem(KEY,JSON.stringify(prefs));
const help=(title,text)=>`data-help-title="${esc(title)}" data-help-text="${esc(text)}"`;
async function request(url,body,method=body?'POST':'GET') {
 const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||`Request failed (${res.status})`);return data;
}

export async function renderTtsForm() {
 const sequence=++renderSequence;
 const current=()=>sequence===renderSequence && host.querySelector('.tts-workspace');
 const host=elements.actionPanel;
 host.innerHTML=`<div class="tts-workspace"><h3>Text to speech</h3><p role="status">Loading local models…</p></div>`;
 try { catalog=await request('/api/tts/status');if(!current())return; } catch(e){if(current())host.querySelector('[role="status"]').textContent=e.message;return;}
 const model=catalog.models.find(m=>m.id===prefs.model)||catalog.models[0];prefs.model=model.id;
 if(!prefs.output)prefs.output=catalog.default_output;
 host.innerHTML=`<div class="tts-workspace">
 <div class="tts-cards"><section class="tts-card tts-input-card" aria-labelledby="ttsInputTitle"><h3 id="ttsInputTitle">Speech input</h3>
 <div class="tts-row"><label for="ttsModel">Model</label><select id="ttsModel" ${help('TTS model','+ means a download or pinned-version update is available. Select it, then press + to install.')}></select><button id="ttsInstall" ${help('Download / update model','Download matching model files and install the pinned runtime; existing versions are kept until validation passes.')}>+</button><button id="ttsRefresh" ${help('Refresh models','Check installed model and runtime versions again.')}>↻</button></div>
 <div class="tts-row"><label for="ttsVoice">Voice</label><select id="ttsVoice" ${help('Voice','Choose a voice. + marks voices needing a download. Selections are saved separately per model.')}></select></div>
 <div class="tts-row"><label for="ttsQuality">Quality / model size</label><select id="ttsQuality" ${help('Synthesis quality','Piper selects a trained low, medium or high checkpoint where available. Kitten selects model size; Supertonic selects inference steps. + downloads only the selected version.')}></select></div>
 <p id="ttsModelInfo" class="dream-hint"></p>
 <section id="ttsControls" aria-label="Model synthesis controls"></section>
 <label for="ttsText">What to say</label><textarea id="ttsText" rows="6" maxlength="10000" placeholder="Type the words you want spoken…" ${help('Speech text','Highlight a passage to generate only that selection, or leave nothing selected to speak the full text. Up to 10,000 characters.')}>${esc(prefs.text)}</textarea>
 <p class="dream-hint">Highlight text to speak just that passage; otherwise Generate uses the full script.</p>
 <div class="tts-row"><label><input id="ttsSave" type="checkbox" ${prefs.save?'checked':''} ${help('Save audio','Keep an audio file at the output path. When off, audio is temporary and can be discarded.')}> Save audio</label><label><input id="ttsSpeaker" type="checkbox" ${prefs.speaker?'checked':''} ${help('Speaker','Play new results when ready. Changing this toggle does not pause an already playing clip.')}> Speaker</label><label for="ttsFormat">Output format</label><select id="ttsFormat" ${help('Audio format','The shared FFmpeg exporter converts the model output into the selected format.')}>${Object.entries(catalog.formats).map(([id,s])=>`<option value="${id}" ${prefs.format===id?'selected':''}>${esc(s.label)}</option>`).join('')}</select><button id="ttsGear" aria-label="Advanced audio export settings" ${help('Audio export settings','Open centered, codec-specific channel, sample rate, depth, bitrate or compression settings.')}>⚙</button></div>
 <div class="tts-row"><label for="ttsOutput">Output path</label><input id="ttsOutput" type="text" value="${esc(prefs.output)}" ${help('Output audio path','Absolute filename. The extension follows your selected format; existing files get a unique name.')}></div>
 <div class="tts-row"><button id="ttsGenerate" ${help('Generate speech','Generate the highlighted passage, or the full text if nothing is selected, then convert, save and/or play the audio.')}>Generate speech</button><span id="ttsProgress" role="status" aria-live="polite"></span></div>
 <progress id="ttsDownloadProgress" hidden></progress>
 <p class="dream-hint">Local CPU engines · Download only the voice and quality you choose · Output encoding is independent of synthesis quality.</p></section>
 <section class="tts-card tts-playback-card" aria-labelledby="ttsPlaybackTitle"><h3 id="ttsPlaybackTitle">Playback</h3><div id="ttsResult"><p class="dream-hint">Generate speech to create a clip.</p></div></section>
 <aside class="tts-card tts-clip-card" aria-labelledby="ttsClipTitle"><h3 id="ttsClipTitle">Current clip</h3><div id="ttsClipInfo"><p class="dream-hint">The playing clip’s script and settings appear here.</p></div></aside></div>
 </div>`;
 const find=id=>host.querySelector('#'+id);
 const readControls=()=>Object.fromEntries([...find('ttsControls').querySelectorAll('[data-tts-control]')].map(el=>[
  el.dataset.ttsControl,el.type==='checkbox'?el.checked:el.type==='number'?(el.value===''?null:el.valueAsNumber):el.value,
 ]));
 const paintControls=m=>{
  const values=prefs.synthesis[m.id]||{};
  const field=c=>{
   const value=Object.hasOwn(values,c.id)?values[c.id]:c.default;
   const attrs=`id="ttsControl_${esc(c.id)}" data-tts-control="${esc(c.id)}" ${help(c.label,c.help)}`;
   const control=c.type==='boolean'?`<input type="checkbox" ${attrs} ${value?'checked':''}>`:c.type==='select'?`<select ${attrs}>${c.options.map(o=>`<option value="${esc(o.id)}" ${value===o.id?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`:`<input type="number" ${attrs} min="${c.min}" max="${c.max}" step="${c.step}" value="${value??''}" placeholder="Voice default">`;
   return `<label class="tts-control ${c.type==='boolean'?'tts-control-check':''}" data-field="${esc(c.id)}" for="ttsControl_${esc(c.id)}">${c.type==='boolean'?control:''}<span>${esc(c.label)}</span>${c.type==='boolean'?'':control}</label>`;
  };
  const basic=m.controls.filter(c=>!c.advanced),advanced=m.controls.filter(c=>c.advanced);
  find('ttsControls').innerHTML=`<div class="tts-controls-heading"><strong>Synthesis controls</strong><button id="ttsResetControls" ${help('Reset model controls','Restore the selected model’s native defaults; other models keep their settings.')}>Reset</button></div><div class="tts-controls-grid">${basic.map(field).join('')}</div>${advanced.length?`<details id="ttsAdvancedControls" ${prefs.controlsExpanded[m.id]?'open':''}><summary ${help('Advanced synthesis controls','Native pronunciation, chunking or voice-shaping settings supported by this model.')}>Advanced model controls</summary><div class="tts-controls-grid">${advanced.map(field).join('')}</div></details>`:''}`;
  const visibility=()=>{const language=find('ttsControls').querySelector('[data-field="language"]');if(language && m.engine==='kokoro')language.hidden=Boolean(find('ttsControl_is_phonemes')?.checked);};
  visibility();
  find('ttsControls').oninput=()=>{prefs.synthesis[m.id]=readControls();remember();visibility();invalidate();};
  find('ttsResetControls').onclick=()=>{prefs.synthesis[m.id]={};paintControls(m);remember();invalidate();};
  if(find('ttsAdvancedControls'))find('ttsAdvancedControls').ontoggle=e=>{prefs.controlsExpanded[m.id]=e.target.open;remember();};
 };
 const paint=()=>{
  find('ttsModel').innerHTML=catalog.models.map(m=>`<option value="${esc(m.id)}" ${prefs.model===m.id?'selected':''}>${m.ready?'':'＋ '}${esc(m.label)}${m.status==='upgrade'?' · update available':''}</option>`).join('');
  const m=catalog.models.find(m=>m.id===prefs.model);
  const voices=m.voices||[{id:m.voice,label:m.voice}];
  if(!voices.some(v=>v.id===prefs.voices[m.id]))prefs.voices[m.id]=m.voice;
  find('ttsVoice').innerHTML=voices.map(v=>`<option value="${esc(v.id)}" ${v.id===prefs.voices[m.id]?'selected':''}>${v.ready?'':'＋ '}${esc(v.label)}</option>`).join('');
  const voice=voices.find(v=>v.id===prefs.voices[m.id]);
  const key=m.id+':'+voice.id;
  const qualities=voice.qualities;
  if(!qualities.some(q=>q.id===prefs.qualities[key]))prefs.qualities[key]=qualities.some(q=>q.id===m.quality)?m.quality:qualities[0].id;
  const quality=qualities.find(q=>q.id===prefs.qualities[key]);
  find('ttsQuality').innerHTML=qualities.map(q=>`<option value="${esc(q.id)}" ${q.id===quality.id?'selected':''}>${q.ready?'':'＋ '}${esc(q.label)}</option>`).join('');
  find('ttsQuality').closest('.tts-row').hidden=qualities.length<2;
  find('ttsInstall').setAttribute('aria-label',`Download ${m.label} · ${voice.label} · ${quality.label}`);
  find('ttsInstall').hidden=quality.ready;find('ttsInstall').disabled=Boolean(running||catalog.active_job);
  find('ttsGenerate').disabled=!quality.ready||Boolean(running||catalog.active_job);
  find('ttsModelInfo').innerHTML=`${quality.ready?'Ready':'Needs '+(quality.status==='upgrade'?'update':'download')} · ${Math.round(quality.bytes/1e6)} MB · Runtime ${esc(m.runtime)} · ${esc(m.license)} · <a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">Source</a>`;
  find('ttsOutput').disabled=false;
  paintControls(m);
 };
 const busy=()=>{
  const m=catalog.models.find(m=>m.id===find('ttsModel').value);
  const voice=m?.voices.find(v=>v.id===find('ttsVoice').value);
  const quality=voice?.qualities.find(q=>q.id===find('ttsQuality').value);
  const active=Boolean(running||catalog.active_job);
  find('ttsGenerate').disabled=active||!quality?.ready;
  find('ttsInstall').disabled=active;
  if(find('ttsPlayUpdated'))find('ttsPlayUpdated').disabled=active||!quality?.ready;
 };
 const showUpdated=()=>{
  find('ttsUpdated')?.remove();
  if(!staleResult)return;
  const notice=document.createElement('div');notice.id='ttsUpdated';
  notice.innerHTML=`<p>Text or settings changed. Edits apply to the next generation.</p><button id="ttsPlayUpdated" ${help('Generate & Play','Generate the current text and settings, then replace the playing clip when the new audio is ready.')}>Generate & Play</button>`;
  find('ttsResult').append(notice);find('ttsPlayUpdated').onclick=()=>run('generate',true);busy();
 };
 const release=async()=>{
  stopPlayback();
  if(playbackAudio){playbackAudio.removeAttribute('src');playbackAudio.load();playbackAudio=null;}
  lastGenerationJob=null;staleResult=false;
  find('ttsResult')?.replaceChildren();
  find('ttsClipInfo').innerHTML='<p class="dream-hint">No current clip.</p>';
  if(previewId){const id=previewId;previewId=null;await fetch('/api/tts/preview/'+id,{method:'DELETE'});}
 };
 const invalidate=()=>{
  editRevision++;
  if(!lastGenerationJob && !previewId && !running && !staleResult)return;
  staleResult=true;
  showUpdated();
 };
 const run=async(kind,playNow=false)=>{
  if(running||catalog.active_job)return;
  const submittedRevision=editRevision;
  // Selection offsets survive focus moving from the textarea to either Generate button.
  const textInput=find('ttsText');
  const draftText=textInput.value;
  const speechText=textInput.selectionEnd>textInput.selectionStart?draftText.slice(textInput.selectionStart,textInput.selectionEnd):draftText;
  // Snapshot the real controls before any network await or DOM replacement.
  const payload=kind==='install'?{model:find('ttsModel').value,voice:find('ttsVoice').value,quality:find('ttsQuality').value}:{
   model:find('ttsModel').value,text:speechText.trim(),voice:find('ttsVoice').value,quality:find('ttsQuality').value,
   format:find('ttsFormat').value,save_audio:find('ttsSave').checked,
   output_path:find('ttsOutput').value,controls:readControls(),settings:structuredClone(prefs.settings[find('ttsFormat').value]||{}),
  };
  if(kind==='generate'){
   prefs.text=draftText;prefs.model=payload.model;prefs.format=payload.format;
   prefs.output=payload.output_path;prefs.save=payload.save_audio;prefs.voices[payload.model]=payload.voice;prefs.qualities[payload.model+':'+payload.voice]=payload.quality;prefs.synthesis[payload.model]=payload.controls;remember();
  }
  running='starting';busy();find('ttsProgress').textContent='Starting…';
  try {
   if(!current())return;
   const job=await request('/api/tts/'+kind,payload);
   if(kind==='generate'){lastGenerationJob=job.job;generationRevisions.set(job.job,submittedRevision);}
   await watch(job.job,kind,playNow);
  } catch(e){if(current())find('ttsProgress').textContent=e.message;}
  finally {if(!current())return;running=null;catalog=await request('/api/tts/status').catch(()=>catalog);if(find('ttsGenerate')){if(kind==='install')paint();busy();find('ttsDownloadProgress').hidden=true;}}
 };
 const watch=async(token,kind,playNow=false)=>{
  running=token;
  while(true){
   const res=await fetch('/api/tts/job/'+token);const job=await res.json();
   if(!current() || !find('ttsProgress'))return;
   find('ttsProgress').textContent=job.message||job.error||'Working…';
   const bar=find('ttsDownloadProgress');bar.hidden=false;
   if(job.total){bar.max=job.total;bar.value=job.current;}else bar.removeAttribute('value');
   if(job.status==='failed')throw Error(job.error);
   if(job.status==='done'){
    if(kind==='generate'){
     const r=job.result;const oldPreview=previewId;previewId=r.preview_id;
     if(generationRevisions.has(token))staleResult=generationRevisions.get(token)!==editRevision;
     find('ttsResult').innerHTML=`<audio id="ttsAudio" controls src="${esc(r.preview)}"></audio><p>${r.output?`Saved: ${esc(r.output)}`:'Temporary preview · discarded when replaced, on request, or after one hour.'}</p><button id="ttsDiscard" ${help('Discard preview','Stop playback and remove the temporary preview. Saved audio is kept.')}>Discard preview</button>`;
     const m=catalog.models.find(m=>m.id===r.model);
     const voice=m?.voices.find(v=>v.id===r.voice);
     const quality=voice?.qualities.find(q=>q.id===r.quality);
     const row=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(String(value??'Voice default'))}</dd></div>`;
     const values=Object.entries(r.controls||{}).map(([key,value])=>{
      const c=m?.controls.find(c=>c.id===key);
      const display=c?.options?.find(o=>o.id===value)?.label??(typeof value==='boolean'?(value?'Yes':'No'):value);
      return row(c?.label||key,display);
     }).join('');
     const labels={channels:'Channels',sample_rate:'Sample rate',bitrate:'Bitrate (kb/s)',sample_bits:'Sample depth (bits)',compression:'Compression'};
     find('ttsClipInfo').innerHTML=`<dl class="tts-clip-settings">${row('Model',m?.label||r.model||'Unavailable')}${row('Voice',voice?.label||r.voice)}${row('Quality',quality?.label||r.quality)}${row('Revision',r.revision)}${row('Format',catalog.formats[r.format]?.label||r.format)}${row('File',r.output||r.preview_id+'.'+catalog.formats[r.format]?.extension)}${row('Save audio',r.output?'Yes':'No · temporary preview')}</dl><label for="ttsPlaybackScript">Playback script</label><textarea id="ttsPlaybackScript" readonly rows="6">${esc(r.text||'')}</textarea><h4>Synthesis settings</h4><dl class="tts-clip-settings">${values}</dl><h4>Audio export settings</h4><dl class="tts-clip-settings">${Object.entries(r.settings||{}).map(([key,value])=>row(labels[key]||key,key==='channels'?(value===2?'Stereo':'Mono'):key==='sample_rate'&&value===0?'Keep source':value)).join('')}</dl>`;
     const audio=find('ttsAudio');
     if(playbackAudio?.dataset.previewId===r.preview_id)audio.replaceWith(playbackAudio);
     else {stopPlayback();playbackAudio=audio;playbackAudio.dataset.previewId=r.preview_id;}
     playbackAudio.loop=false;
     if(oldPreview && oldPreview!==r.preview_id)fetch('/api/tts/preview/'+oldPreview,{method:'DELETE'}).catch(()=>{});
     showUpdated();
     find('ttsDiscard').onclick=()=>{find('ttsAudio').pause();release();};
     const firstPresentation=!autoPlayed.has(token);
     autoPlayed.add(token);
     if((prefs.speaker || playNow) && firstPresentation){
      try{await playbackAudio.play();}catch{if(current())find('ttsProgress').textContent='Audio ready. Browser blocked automatic playback; press Play.';}
     }
    }
    return;
   }
   if(job.ok===false)throw Error(job.error);
   await new Promise(resolve=>setTimeout(resolve,500));
  }
 };
 find('ttsModel').onchange=e=>{prefs.model=e.target.value;remember();paint();invalidate();};
 find('ttsVoice').onchange=e=>{const quality=find('ttsQuality').value;prefs.voices[prefs.model]=e.target.value;const key=prefs.model+':'+e.target.value;prefs.qualities[key] ||= quality;paint();remember();invalidate();};
 find('ttsQuality').onchange=e=>{prefs.qualities[prefs.model+':'+find('ttsVoice').value]=e.target.value;paint();remember();invalidate();};
 find('ttsText').oninput=e=>{prefs.text=e.target.value;remember();invalidate();};
 find('ttsOutput').oninput=e=>{prefs.output=e.target.value;remember();invalidate();};
 find('ttsSave').onchange=e=>{prefs.save=e.target.checked;remember();paint();invalidate();};
 find('ttsSpeaker').onchange=e=>{prefs.speaker=e.target.checked;remember();};
 find('ttsFormat').onchange=e=>{prefs.format=e.target.value;const extension=catalog.formats[prefs.format].extension;prefs.output=prefs.output.replace(/\.[^/.]+$/, '')+'.'+extension;find('ttsOutput').value=prefs.output;remember();invalidate();};
 find('ttsGear').onclick=()=>openAudioExportDialog(prefs.format,catalog.formats,prefs.settings[prefs.format]||{},settings=>{prefs.settings[prefs.format]=settings;remember();invalidate();});
 find('ttsInstall').onclick=()=>run('install');find('ttsGenerate').onclick=()=>run('generate');
 find('ttsRefresh').onclick=async()=>{try{catalog=await request('/api/tts/status');paint();}catch(e){find('ttsProgress').textContent=e.message;}};
 paint();
 if(staleResult)showUpdated();
 const resume=catalog.active_job||lastGenerationJob;
 if(resume){const job=await request('/api/tts/job/'+resume);running=job.job;busy();watch(job.job,job.kind).catch(e=>{if(current())find('ttsProgress').textContent=e.message;}).finally(async()=>{if(!current())return;running=null;catalog=await request('/api/tts/status');if(job.kind==='install')paint();busy();find('ttsDownloadProgress').hidden=true;});}
}
