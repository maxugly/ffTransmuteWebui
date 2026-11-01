// Vectorize tab — complete vanilla ES6 (spec: vectorize-tab-spec.md)
(function () {
  const API = '/vectorize';
  let currentJob = null;

  function id(n){ return document.getElementById(n); }
  function fmtTime(s){ return (s||0).toFixed(1)+'s'; }

  async function fetchJSON(url, opts){
    const r = await fetch(url, opts||{});
    return r.json();
  }

  function renderEngines(d){
    const box = id('v-engines');
    if(!box||!d.engines) return;
    box.innerHTML = d.engines.map(e=>{
      const opts = (window.VECTORIZE_MANIFEST||{})[e.id];
      const optsHtml = opts ? '<details><summary>Options</summary><div class="v-opts">'+
        opts.options.map(o=>{
          if(o.type==='bool') return `<label><input type="checkbox" id="v-opt-${e.id}-${o.key}" ${o.default?'checked':''}/> ${o.key}</label>`;
          if(o.type==='select') return `<label>${o.key}<select id="v-opt-${e.id}-${o.key}">${o.choices.map(c=>`<option ${c===o.default?'selected':''}>${c}</option>`).join('')}</select></label>`;
          return `<label>${o.key}<input type="number" id="v-opt-${e.id}-${o.key}" value="${o.default}" min="${o.min||''}" max="${o.max||''}" step="${o.step||1}"/></label>`;
        }).join('')+'</div></details>' : '';
      return `<label class="v-engine"><input type="checkbox" id="v-en-${e.id}" ${e.available?'checked':''} ${!e.available?'disabled':''}/><b>${e.id}</b> ${!e.available?'<span class="v-bad">('+ (e.reason||'unavailable') +')</span>':''}</label>${optsHtml}`;
    }).join('');
  }

  async function loadStatus(){
    try{
      const d = await fetchJSON(API+'/status');
      renderEngines(d);
    }catch(e){ console.error('status',e); }
  }

  function getOptions(){
    const opts = {};
    ['vtracer','inkscape','neural'].forEach(eid=>{
      const m = (window.VECTORIZE_MANIFEST||{})[eid];
      if(!m) return;
      const o = {};
      m.options.forEach(opt=>{
        const el = id('v-opt-'+eid+'-'+opt.key);
        if(!el) return;
        if(opt.type==='bool') o[opt.key]=el.checked;
        else if(opt.type==='select') o[opt.key]=el.value;
        else o[opt.key]=Number(el.value);
      });
      opts[eid]=o;
    });
    return opts;
  }

  async function doUpload(file){
    const fd = new FormData();
    fd.append('file', file);
    const d = await fetchJSON(API+'/upload', {method:'POST', body:fd});
    return d;
  }

  async function doRun(jobId){
    const enabled = ['vtracer','inkscape','neural'].filter(eid=>{
      const el = id('v-en-'+eid);
      return el && el.checked && !el.disabled;
    });
    const payload = {enabled, options:getOptions()};
    return fetchJSON(API+'/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
  }

  function renderResults(d){
    const out = id('v-results');
    if(!out) return;
    if(!d.results||!d.results.length){ out.innerHTML='<p>No results.</p>'; return; }
    out.innerHTML = `
      <div class="v-compare"><label>Compare <input type="range" id="v-blend" min="0" max="100" value="50" oninput="blendResults(this.value)"/></label></div>
      <div class="v-grid">${d.results.map(r=>`<article class="v-card" id="v-card-${r.engine_id}">
        <h4>${r.engine_id}</h4>
        <div class="v-preview" id="v-preview-${r.engine_id}">
          <svg viewBox="0 0 200 200" style="width:100%;height:auto;border:1px solid #ccc;" data-src="${r.svg_path||''}">
            <text x="10" y="20">Loading SVG...</text>
          </svg>
        </div>
        <div class="v-meta">time:${fmtTime(r.elapsed_s)} | size:${r.bytes||'?'}B</div>
        <a href="${r.svg_path||'#'}" download="${r.engine_id}.svg">Download SVG</a>
      </article>`).join('')}</div>`;
    // load SVG content inline (fetch text and inject)
    d.results.forEach(r=>{
      if(r.svg_path){
        fetch(r.svg_path).then(resp=>resp.text()).then(txt=>{
          const container = id('v-preview-'+r.engine_id);
          if(container) container.innerHTML = txt;
        }).catch(()=>{});
      }
    });
  }

  window.blendResults = function(v){
    // overlay blend: two visible cards can be blended via CSS opacity on second
    const cards = document.querySelectorAll('.v-card');
    if(cards.length>=2){ cards[1].style.opacity = (v/100).toFixed(2); }
  };

  async function initUI(){
    try{
      const m = await fetchJSON(API+'/manifest');
      window.VECTORIZE_MANIFEST = (m.manifests||{});
      renderEngines({engines:Object.values(window.VECTORIZE_MANIFEST||{}).map(x=>({id:x.id,available:true}))});
    }catch(e){ console.error('manifest',e); }
    const main = id('v-main');
    if(!main) return;
    main.innerHTML = `
      <section class="v-upload"><label>Drop PNG/JPG or <input type="file" accept="image/*" id="v-file"/></label></section>
      <section class="v-run"><button id="v-run-btn">Run all enabled</button></section>
      <section class="v-progress" id="v-progress" style="display:none"><pre id="v-log"></pre></section>
      <section id="v-results"></section>`;
    id('v-file').addEventListener('change', async (e)=>{
      const f = e.target.files[0]; if(!f) return;
      id('v-log').textContent = 'Uploading...';
      id('v-progress').style.display='block';
      try{
        const up = await doUpload(f);
        id('v-log').textContent = 'Uploaded '+(up.job_id||'?');
        window.currentJob = up.job_id;
        // demo run trigger
        const res = await doRun((up.job_id||'demo'));
        id('v-log').textContent += '\nDone '+(res.results||[]).length+' engines';
        renderResults(res);
      }catch(err){ id('v-log').textContent = 'Error: '+err; }
    });
    id('v-run-btn').addEventListener('click', async ()=>{
      id('v-progress').style.display='block';
      id('v-log').textContent = 'Running...';
      try{
        const res = await doRun('manual');
        id('v-log').textContent = 'Finished '+(res.results||[]).length+' results';
        renderResults(res);
      }catch(err){ id('v-log').textContent='Error: '+err; }
    });
    loadStatus();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', async()=>await initUI());
  else (async()=>await initUI())();
})();
