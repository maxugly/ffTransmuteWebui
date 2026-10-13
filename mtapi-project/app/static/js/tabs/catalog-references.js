/* Research evidence is supplemental: never uses the catalog source selector. */
import { escapeHtml } from '/js/utils.js';

const esc = escapeHtml;
let selectedPath = null;
let offset = 0;
let generation = 0;
const el = (id) => document.getElementById(id);
const value = (v) => v == null || v === '' ? 'Unknown' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
const fmt = (v) => esc(value(v));

async function api(url, body) {
  const response = await fetch('/api/media-catalog/references' + url, body == null ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Research request failed');
  return data;
}

function sourceLink(url) {
  if (Array.isArray(url)) return url.map(sourceLink).join('<br>');
  if (typeof url !== 'string') return fmt(url);
  // Research can store several source URLs in one cell. Link each separately.
  const urls = url.match(/https?:\/\/[^\s;|<>]+/gi) || [];
  if (!urls.length) return fmt(url);
  return urls.map((item) => {
    const href = item.replace(/[,\.]+$/, '');
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>`;
  }).join('<br>');
}

function card(entry, data) {
  const r = entry.metadata;
  const m = data.media || {};
  const d = data.detected || {};
  const bpm = d.bpm;
  const pairs = [
    ['Song', m.title, r.track_title || r.title],
    ['Artist', m.artist, r.artist],
    ['Album / release', m.album, r.release_or_album || r.album],
    ['Release date', null, r.release_date],
    ['Recording / version', null, r.recording_version],
    ['Musical key', d.key, r.key_normalized || r.key_reported_raw],
    ['Key as reported', null, r.key_reported_raw],
    ['Mode', d.key?.match(/\b(major|minor)\b/i)?.[0], r.mode_source_confirmed],
    ['BPM', bpm, r.bpm_reported],
    ['Half-time BPM', bpm == null ? null : bpm / 2, r.bpm_half_time],
    ['Double-time BPM', bpm == null ? null : bpm * 2, r.bpm_double_time],
    ['Camelot', d.camelot, r.camelot],
    ['Duration', m.duration == null ? null : `${m.duration} seconds`, r.duration],
    ['Producer (* = unconfirmed at track level)', null, r.producer_credit],
    ['Tempo confidence', m.tempo_conf, r.confidence],
    ['Key strength', m.key_strength, null],
    ['Verification', null, r.verified],
    ['Review status', null, r.manual_review],
    ['Original source key', null, r.source_key],
    ['Original source BPM', null, r.source_bpm],
    ['Alternate key reports', null, r.alternate_key_reports],
    ['Research notes', null, r.notes],
  ];
  let relationship = '';
  const reported = Number(r.bpm_reported);
  if (bpm > 0 && reported > 0) {
    const choices = [[1, 'same tempo'], [0.5, 'model is half-time'], [2, 'model is double-time']];
    const found = choices.find(([ratio]) => Math.abs(bpm - reported * ratio) <= reported * ratio * 0.02);
    relationship = found ? `Tempo relationship: ${found[1]} (within 2%).` : `Tempo difference: ${(bpm - reported).toFixed(2)} BPM.`;
  }
  return `<article class="mc-ref-card" data-reference-id="${entry.id}">
    <h4>${fmt(r.artist)} — ${fmt(r.track_title || r.title)} · ${fmt(r.release_or_album || r.album)}</h4>
    <p>${fmt(entry.match || 'Research library — not linked to a local file')} ${esc(relationship)}</p>
    ${data.media ? `<button type="button" class="btn btn-sm" data-ref-link="${entry.id}" data-included="true">Confirm link to this file</button>
      <button type="button" class="btn btn-sm" data-ref-link="${entry.id}" data-included="false">Exclude for this file</button>` : ''}
    <table class="mc-ref-table"><thead><tr><th>Field</th><th>Local audio analysis</th><th>External research</th></tr></thead>
    <tbody>${pairs.map(([label, scan, ref]) => `<tr><th>${esc(label)}</th><td>${fmt(scan)}</td><td>${fmt(ref)}</td></tr>`).join('')}
    <tr><th>Source</th><td>${data.media ? 'Local audio analysis' : 'Unknown'}</td><td>${sourceLink(r.source_url)}</td></tr></tbody></table>
    <details><summary>All original fields / edit research</summary>
      <p>Save edits independently of audio analysis. Previous values remain in the research revision log. A bare key does not establish major/minor.</p>
      <textarea aria-label="Research JSON ${entry.id}" data-ref-json="${entry.id}" rows="14">${esc(JSON.stringify(r, null, 2))}</textarea>
      <button type="button" class="btn btn-sm" data-ref-save="${entry.id}">Save research only</button>
      <p>Imported from ${fmt(entry.catalog)}</p>
    </details></article>`;
}

async function load() {
  const ticket = ++generation;
  const q = el('mcRefSearch')?.value || '';
  const params = new URLSearchParams({ q, offset: String(offset) });
  if (selectedPath) params.set('path', selectedPath);
  el('mcRefStatus').textContent = 'Loading research…';
  try {
    const data = await api('?' + params);
    if (ticket !== generation || !el('mcRefResults')) return;
    el('mcRefStatus').textContent = `${data.total} research records · ${data.media ? selectedPath : `${data.count} search results`}`;
    el('mcRefResults').innerHTML = (data.media ? `<p>Detected key/BPM are shown below. Current catalog values: ${fmt(data.media.key_name)} / ${fmt(data.media.tempo)} BPM (${fmt(data.media.key_source)} / ${fmt(data.media.tempo_source)}). File tags and research remain independent.</p>` : '')
      + (data.references.length ? data.references.map((entry) => card(entry, data)).join('') : '<p>No matching research. Search the library to locate evidence and confirm a link. Files without artist/title tags are never guessed from filenames.</p>');
    el('mcRefPrev').disabled = !!selectedPath || offset === 0;
    el('mcRefNext').disabled = !!selectedPath || offset + data.references.length >= data.count;
  } catch (err) {
    if (ticket === generation && el('mcRefStatus')) el('mcRefStatus').textContent = err.message;
  }
}

export function openCatalogReferences(path) {
  selectedPath = path;
  offset = 0;
  el('mcRefSearch').value = '';
  el('mcReferences').open = true;
  el('mcReferences').scrollIntoView({ block: 'nearest' });
  load();
}

export function mountCatalogReferences() {
  selectedPath = null;
  offset = 0;
  el('mcRefImport').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const data = await api('/import', { path: el('mcRefPath').value.trim() });
      await load();
      el('mcRefStatus').textContent += ` · Imported ${data.inserted}, already present ${data.existing}.`;
    } catch (err) { el('mcRefStatus').textContent = err.message; }
    finally { e.target.disabled = false; }
  });
  el('mcRefBrowse').addEventListener('click', () => { selectedPath = null; offset = 0; load(); });
  el('mcRefFind').addEventListener('click', () => { offset = 0; load(); });
  el('mcRefPrev').addEventListener('click', () => { offset = Math.max(0, offset - 50); load(); });
  el('mcRefNext').addEventListener('click', () => { offset += 50; load(); });
  el('mcRefSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { offset = 0; load(); } });
  el('mcRefResults').addEventListener('click', async (e) => {
    const save = e.target.closest('[data-ref-save]');
    const link = e.target.closest('[data-ref-link]');
    if (!save && !link) return;
    const button = save || link;
    button.disabled = true;
    try {
      if (save) {
        const id = Number(save.dataset.refSave);
        const metadata = JSON.parse(el('mcRefResults').querySelector(`[data-ref-json="${id}"]`).value);
        await api('/update', { id, metadata });
      } else {
        await api('/link', { id: Number(link.dataset.refLink), path: selectedPath, included: link.dataset.included === 'true' });
      }
      await load();
      el('mcRefStatus').textContent += save ? ' · Research saved.' : ' · Link updated.';
    } catch (err) { el('mcRefStatus').textContent = err.message; button.disabled = false; }
  });
  el('mcReferences').addEventListener('toggle', () => { if (el('mcReferences').open) load(); });
}

export const catalogReferencesHtml = `<details id="mcReferences" class="mc-reference-library">
  <summary>External research · import, browse, compare</summary>
  <p>Research is evidence, not ground truth. Conflicting sources and releases remain separate. * marks an unconfirmed producer credit. Unknown values remain unknown.</p>
  <div class="mc-ref-controls">
    <input id="mcRefPath" aria-label="Research catalog path" placeholder="Absolute path to JSON or CSV" />
    <button type="button" id="mcRefImport" class="btn btn-sm">Import research</button>
    <button type="button" id="mcRefBrowse" class="btn btn-sm">Browse all research</button>
  </div>
  <div class="mc-ref-controls">
    <input id="mcRefSearch" aria-label="Search research" placeholder="Search artist, song, release or source" />
    <button type="button" id="mcRefFind" class="btn btn-sm">Search research</button>
    <button type="button" id="mcRefPrev" class="btn btn-sm" disabled>Previous</button>
    <button type="button" id="mcRefNext" class="btn btn-sm" disabled>Next</button>
  </div>
  <p id="mcRefStatus" role="status"></p><div id="mcRefResults"></div>
</details>`;
