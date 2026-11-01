// Vectorize tab — vanilla ES6 skeleton (spec: vectorize-tab-spec.md)
console.log("Vectorize tab loaded");

const VectorizeTab = {
  init() {
    // mount to container #tab-vectorize if present
    const c = document.getElementById('tab-vectorize');
    if (!c) return;
    c.innerHTML = `
      <div class="v-header">Vectorize — Raster → SVG</div>
      <div class="v-layout">
        <aside class="v-sidebar" id="v-engines"></aside>
        <main class="v-main" id="v-main"></main>
      </div>`;
    this.loadEngines();
  },
  async loadEngines() {
    try {
      const r = await fetch('/vectorize/status');
      const d = await r.json();
      const sidebar = document.getElementById('v-engines');
      if (sidebar && d.engines) {
        sidebar.innerHTML = d.engines.map(e => `
          <label><input type="checkbox" id="v-en-${e.id}" ${e.available?'checked':''} ${!e.available?'disabled':''}/>
          ${e.id}${!e.available?' (unavailable)':''}</label>`).join('');
      }
    } catch(e){ console.error('engine load', e); }
  }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => VectorizeTab.init());
else VectorizeTab.init();
