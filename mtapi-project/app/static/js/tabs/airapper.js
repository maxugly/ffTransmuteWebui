/** AI Rapper tab (spec: docs/airapper-spec.md).
 *
 * Write → direct → set the pocket → produce → keep.
 *
 *   agent_chat     sidebar director: marked tiles in, permitted tiles out
 *   music_generate "Make Hot Fire" — prompt from the description, lyrics from
 *                  the textarea, tempo/key/meter from the Music Theory tile,
 *                  and the returned WAV joins the media pool
 *
 * Two persistence layers, deliberately separate (§4):
 *   Layer A  tile controls carry stable ids; the delegated capture in app.js
 *            snapshots them into state.formState.airapper and replays them —
 *            no endpoint, no fetch, rides pool_state.json + *.ffproject.json
 *   Layer B  saved songs are a library: /api/airapper/tracks (airapper_store)
 *   UI prefs sidebar collapse + tile hide/In/Out → localStorage only
 *
 * Help law: every hover hint is data-help-title / data-help-text. No title=
 * anywhere in this file.
 */
import { elements, logConsole, addPathsToPool } from '/app.js?v=2';
import { runOpWithCancel } from '/js/job-control.js';
import { escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, knobUnitHtml } from '/js/ui/knobs.js?v=6';

// ── constants ────────────────────────────────────────────────────────────────

const LS_PREFS = 'mtapi.airapper.ui_prefs';

const AR_MODELS = [
  { v: 'acestep-v15-base', t: 'ACE-Step v1.5 base' },
  { v: 'acestep-v15-turbo', t: 'ACE-Step v1.5 turbo (fast)' },
  { v: 'acestep-v15-sft', t: 'ACE-Step v1.5 SFT (lyric-led)' },
];
const AR_DURATIONS = [10, 15, 20, 30, 45, 60];
const AR_BACKENDS = [
  { v: 'grok', t: 'grok' }, { v: 'agy', t: 'agy' },
  { v: 'deepseek', t: 'deepseek' }, { v: 'openrouter', t: 'openrouter' },
  { v: 'xai', t: 'xai' }, { v: 'openai', t: 'openai' }, { v: 'groq', t: 'groq' },
  { v: 'stub', t: 'stub (offline)' },
];

// FL-Studio-style spelling: sharps, major group then minor group.
const AR_KEYS = [
  ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((r) => `${r} major`),
  ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((r) => `${r} minor`),
];
const AR_METERS = ['4/4', '3/4', '6/8'];

const AR_TAGS = [
  { id: 'perlp_v1', label: 'PERLP_V1',
    helpTitle: 'PERLP_V1 — Phonetic Elasticity & Rhythmic Lock',
    helpText: 'Enforces consonant cluster assimilation and schwa injection for multi-syllabic lock. Orthography is null: rhyme validity is judged by phonetic output, not spelling.' },
  { id: 'multisyllabic', label: 'Multisyllabic',
    helpTitle: 'Multisyllabic lock',
    helpText: 'Every bar-end token must land in a trisyllabic pocket — expand disyllables with an injected schwa rather than stretching vowels.' },
  { id: 'internal_rhyme', label: 'Internal rhymes',
    helpTitle: 'Internal rhyme density',
    helpText: 'Rhyme inside the line, not only at the bar end. Forces the phonetic grid to hold mid-phrase.' },
  { id: 'cluster_assim', label: 'Cluster assim.',
    helpTitle: 'Consonant cluster assimilation',
    helpText: 'Merge or swap adjacent consonants across word boundaries — "tight word" becomes /taɪtwɜrd/.' },
  { id: 'schwa', label: 'Schwa inject',
    helpTitle: 'Schwa injection',
    helpText: 'Insert /ə/ to expand a disyllabic token into a trisyllabic pocket — "slight urge" → "slight-uh-urge".' },
  { id: 'r_colored', label: 'R-compress',
    helpTitle: 'R-colored vowel compression',
    helpText: 'Delete the medial vowel in R-controlled syllables and let /r/ act as the nucleus — "bird" → /brd/.' },
  { id: 'semantic_sub', label: 'Semantic sub.',
    helpTitle: 'Semantic subordination',
    helpText: 'Meaning is secondary to the phonetic lock. A perfect word that breaks the grid is discarded for a phonetically compliant synonym.' },
  { id: 'boom_bap', label: 'Boom bap',
    helpTitle: 'Boom bap',
    helpText: 'Sampled pocket — dusty swing, short punchy bars, hard snare against the grid.' },
  { id: 'trap', label: 'Trap',
    helpTitle: 'Trap',
    helpText: 'Triplet pocket, long tail on the 808, bars delivered at half-time behind the hi-hats.' },
  { id: 'wordplay', label: 'Wordplay',
    helpTitle: 'Wordplay',
    helpText: 'Double readings and compound puns. Must still satisfy the phonetic lock — a pun that cannot be pronounced on-grid is dropped.' },
  { id: 'bars16', label: '16 bars',
    helpTitle: 'Sixteen bars',
    helpText: 'A full 16-bar verse with a four-bar hook — the shape ACE-Step covers best.' },
  { id: 'hook', label: 'Hook',
    helpText: 'Write the hook first, then build verses against it so the phonetics stay anchored.', helpTitle: 'Hook-first' },
];

const AR_TILE_LABELS = {
  meta: 'Meta',
  theory: 'Music Theory',
  tags: 'Tags',
  lyrics: 'Lyrics / Output',
};

// Which tile owns which control id — the agent write-map (§5).
const AR_CONTROL_TILES = {
  arTitle: 'meta',
  arDescription: 'meta',
  arTempo: 'theory',
  arSwing: 'theory',
  arKey: 'theory',
  arMeter: 'theory',
  arTags: 'tags',
  arLyrics: 'lyrics',
};

const PERLP_DIRECTIVE = [
  '[PERLP_V1] Phonetic Elasticity & Rhythmic Lock Protocol — mandatory for any lyric work:',
  '- Orthography is null: rhyme validity is decided by phonetic output (IPA), never spelling.',
  '- Consonant cluster assimilation across word boundaries ("Tight word" → /taɪtwɜrd/).',
  '- Schwa injection to expand disyllabic tokens into trisyllabic pockets ("Slight urge" → "Slight-uh-urge").',
  '- R-colored vowel compression: delete medial vowels in R-controlled syllables, let /r/ be the nucleus ("Bird" → /brd/).',
  '- Semantic subordination: meaning is secondary to phonetic lock; swap in a compliant synonym over a perfect word.',
].join('\n');

// ── module state ──────────────────────────────────────────────────────────────

let _tracks = [];
let _chatHistory = [];
let _currentTrackId = null;
let _prefCache = null;

function _el(id) { return document.getElementById(id); }

// ── UI preferences (Layer A.3 — localStorage, never desk state) ──────────────

function loadPrefs() {
  if (_prefCache) return _prefCache;
  const base = {
    sidebarCollapsed: false,
    hide: {},
    in: { meta: true, theory: true, tags: true, lyrics: true },
    out: { meta: true, theory: false, tags: true, lyrics: true },
  };
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (raw) {
      const saved = JSON.parse(raw) || {};
      if (typeof saved.sidebarCollapsed === 'boolean') base.sidebarCollapsed = saved.sidebarCollapsed;
      if (saved.hide && typeof saved.hide === 'object') Object.assign(base.hide, saved.hide);
      if (saved.in && typeof saved.in === 'object') Object.assign(base.in, saved.in);
      if (saved.out && typeof saved.out === 'object') Object.assign(base.out, saved.out);
    }
  } catch (_) { /* corrupt prefs are not worth crashing the tab */ }
  _prefCache = base;
  return base;
}

function savePrefs() {
  try { localStorage.setItem(LS_PREFS, JSON.stringify(loadPrefs())); } catch (_) { /* ignore */ }
}

function toggleFlag(group, key, value) {
  const p = loadPrefs();
  p[group][key] = value;
  savePrefs();
}

// ── tile markup ──────────────────────────────────────────────────────────────

function flagBlock(key) {
  const p = loadPrefs();
  const mk = (cls, attr, checked, hTitle, hText) => `
    <label class="ar-flag ${cls}" data-help-title="${escapeHtml(hTitle)}" data-help-text="${escapeHtml(hText)}">
      <input type="checkbox" ${attr}="${key}"${checked ? ' checked' : ''}> ${cls === 'ar-flag-hide' ? 'Hide' : cls === 'ar-flag-in' ? 'In' : 'Out'}
    </label>`;
  return `<span class="ar-flags">
    ${mk('ar-flag-hide', 'data-ar-hide', !!p.hide[key], 'Hide tile', 'Collapse this tile. UI preference only — never sent to the agent.')}
    ${mk('ar-flag-in', 'data-ar-in', !!p.in[key], 'In — agent reads this tile', 'ON: this tile is sent to the agent as context. OFF: the agent never sees it.')}
    ${mk('ar-flag-out', 'data-ar-out', !!p.out[key], 'Out — agent may write this tile', 'ON: the agent may overwrite this tile and nothing else. OFF: writes to it are discarded.')}
  </span>`;
}

function tileHead(key) {
  const p = loadPrefs();
  const collapsed = !!p.hide[key];
  return `<header class="ar-tile-head">
    <span class="ar-tile-name">${escapeHtml(AR_TILE_LABELS[key])}</span>
    ${flagBlock(key)}
  </header>`;
}

// ── render ───────────────────────────────────────────────────────────────────

export function renderAirapperForm() {
  const prefs = loadPrefs();
  const opts = (list, cur) => list.map((o) => {
    // Entries may be a bare string/number or a {v, t} pair — numbers must not
    // fall through the object branch or every option renders "undefined".
    const isPair = o !== null && typeof o === 'object';
    const v = isPair ? o.v : o;
    const t = isPair ? o.t : String(o);
    return `<option value="${escapeHtml(v)}"${String(v) === String(cur) ? ' selected' : ''}>${escapeHtml(t)}</option>`;
  }).join('');

  elements.actionPanel.innerHTML = `
<div class="ar-workspace${prefs.sidebarCollapsed ? ' is-sidebar-collapsed' : ''}" id="arWorkspace">

  <aside class="ar-side" id="arSidebar">
    <button type="button" class="btn btn-icon-only ar-side-toggle" id="btnArSidebar"
            data-help-title="Collapse / expand the chat sidebar"
            data-help-text="40px icon-only when collapsed, 300px when open. UI preference, remembered locally.">
      <span class="ar-side-toggle-glyph">⇄</span>
    </button>
    <div class="ar-side-body">
      <div class="ar-side-head">
        <select id="arBackend" class="ar-backend"
                data-help-title="Agent backend"
                data-help-text="Which provider serves agent_chat. 'stub' runs offline and returns a canned reply.">
          ${opts(AR_BACKENDS, 'grok')}
        </select>
        <button type="button" class="btn btn-sm" id="btnArNewChat"
                data-help-title="Clear the conversation"
                data-help-text="Drops the chat history sent with the next agent_chat call.">New</button>
      </div>
      <div class="ar-chat-log" id="arChatLog"></div>
      <div class="ar-chat-compose">
        <textarea id="arChatInput" rows="3" placeholder="Direct the session…"
                  data-help-title="Message to the agent"
                  data-help-text="Sent to agent_chat with skill=chat. Every tile marked In is prepended as context."></textarea>
        <button type="button" class="btn btn-primary ar-send" id="btnArSend"
                data-help-title="Send to the agent"
                data-help-text="Only tiles marked Out may be written back. Everything else in the reply is discarded.">Send</button>
      </div>
    </div>
  </aside>

  <section class="ar-main">
    <div class="ar-tiles">

      <section class="ar-tile" data-ar-tile="meta">
        ${tileHead('meta')}
        <div class="ar-tile-body">
          <label class="ar-label" for="arTitle">Title</label>
          <input type="text" id="arTitle" placeholder="track-000001"
                 data-help-title="Title"
                 data-help-text="Auto-derived from the first lyric line, then the description, then track-00000X. Save it to a library track to keep it." />
          <label class="ar-label" for="arDescription">Description</label>
          <textarea id="arDescription" rows="3" placeholder="wu-tang, boom bap, grimy loop, 95bpm"
                    data-help-title="Description"
                    data-help-text="Becomes the music_generate prompt (the caption the SFT template runs). Also the agent's sense of intent."></textarea>
        </div>
      </section>

      <section class="ar-tile" data-ar-tile="theory">
        ${tileHead('theory')}
        <div class="ar-tile-body">
          <div class="ar-knobs">
            ${knobUnitHtml({
              id: 'arTempo', label: 'Tempo (BPM)', value: '95',
              helpTitle: 'Tempo — 40 to 200 BPM',
              helpText: 'Rides music_generate bpm, the ACE-Step SFT tempo meta. 95 is the boom-bap default.',
            })}
            ${knobUnitHtml({
              id: 'arSwing', label: 'Swing (%)', value: '0',
              helpTitle: 'Swing — 0 to 100%',
              helpText: 'Grip on the pocket. 0 is straight; ~55–60 is a hard hip-hop swing. Folded into the description caption.',
            })}
          </div>
          <div class="ar-selects">
            <label class="ar-field">
              <span class="ar-label">Key signature</span>
              <select id="arKey" data-help-title="Key signature"
                      data-help-text="Rides music_generate key (SFT meta). Sharps, major group then minor group.">
                <option value="">N/A (model estimates)</option>
                ${opts(AR_KEYS, '')}
              </select>
            </label>
            <label class="ar-field">
              <span class="ar-label">Time signature</span>
              <select id="arMeter" data-help-title="Time signature"
                      data-help-text="Rides music_generate timesig (SFT meta). 4/4 is the standard rap pocket.">
                ${opts(AR_METERS, '4/4')}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section class="ar-tile" data-ar-tile="tags">
        ${tileHead('tags')}
        <div class="ar-tile-body">
          <div class="ar-chip-row" id="arTagChips"></div>
          <input type="hidden" id="arTags" value="[]" />
        </div>
      </section>

      <section class="ar-tile ar-tile-lyrics" data-ar-tile="lyrics">
        ${tileHead('lyrics')}
        <div class="ar-tile-body">
          <textarea id="arLyrics" rows="12" spellcheck="false" placeholder="[Verse 1]&#10;Write the bars here…"
                    data-help-title="Lyrics / output"
                    data-help-text="Goes to music_generate verbatim as the lyric block. Structure markers like [Verse 1] and [Hook] steer the SFT model."></textarea>
          <div class="ar-fire-row">
            <label class="ar-field">
              <span class="ar-label">Model</span>
              <select id="arModel" data-help-title="ACE-Step checkpoint"
                      data-help-text="base = full quality, turbo = fast draft, SFT = most lyric-faithful.">
                ${opts(AR_MODELS, 'acestep-v15-sft')}
              </select>
            </label>
            <label class="ar-field">
              <span class="ar-label">Seconds</span>
              <select id="arDuration" data-help-title="Clip length"
                      data-help-text="10–60 s. Below 10 is under the model floor.">
                ${opts(AR_DURATIONS, 20)}
              </select>
            </label>
            <label class="ar-field">
              <span class="ar-label">Seed</span>
              <input type="text" id="arSeed" value="42"
                     data-help-title="Seed"
                     data-help-text="Same prompt + seed = bit-identical clip. Bump it for a new take on the same lyrics." />
            </label>
            <button type="button" class="btn btn-primary ar-fire" id="btnArFire"
                    data-help-title="Make Hot Fire"
                    data-help-text="Calls music_generate with the description as prompt, the lyrics, and the tempo/key/meter. The returned WAV joins the media pool.">Make Hot Fire</button>
          </div>
        </div>
      </section>

    </div>

    <section class="ar-tracks">
      <header class="ar-tracks-head">
        <h3>Saved Songs</h3>
        <span class="ar-tracks-count" id="arTrackCount"></span>
        <button type="button" class="btn btn-sm" id="btnArSaveTrack"
                data-help-title="Save this song"
                data-help-text="Writes the tiles to the track library (/api/airapper/tracks). Never touches the current project file.">Save</button>
        <button type="button" class="btn btn-sm" id="btnArNewTrack"
                data-help-title="New song"
                data-help-text="Clears the workspace tiles for a fresh track. Does not touch the library.">New</button>
      </header>
      <div class="ar-track-list" id="arTrackList"></div>
      <div class="ar-track-status" id="arTrackStatus"></div>
    </section>

  </section>
</div>`;

  _setupKnobs();
  _bindUi();
  renderTagChips();
  renderChatLog();
  loadTracks();
  applyTileVisibility();
  // app.js runs applySavedFormState(tab) synchronously right after this returns,
  // so the repair has to land in a later task.
  setTimeout(_repairSelects, 0);
}

/**
 * A restored value that no longer exists (an option was renamed or removed)
 * leaves a <select> blank, and a blank Seconds reads as "undefined" in the
 * produce row. Snap any such control back to its intended default instead of
 * shipping a dead select. Never overrides a value that is still valid.
 */
function _repairSelects() {
  const defaults = { arBackend: 'grok', arDuration: '20', arMeter: '4/4', arKey: '' };
  for (const [id, fallback] of Object.entries(defaults)) {
    const sel = _el(id);
    if (!sel || sel.tagName !== 'SELECT') continue;
    const valid = [...sel.options].some((o) => o.value === sel.value);
    if (valid) continue;
    sel.value = fallback;
    if (![...sel.options].some((o) => o.value === fallback)) sel.selectedIndex = 0;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function _setupKnobs() {
  setupContinuousKnob({
    knobId: 'arTempoKnob', indicatorId: 'arTempoKnobInd',
    valueId: 'arTempoVal', hiddenId: 'arTempo',
    min: 40, max: 200, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'arSwingKnob', indicatorId: 'arSwingKnobInd',
    valueId: 'arSwingVal', hiddenId: 'arSwing',
    min: 0, max: 100, decimals: 0,
  });
}

function _bindUi() {
  _el('btnArSidebar')?.addEventListener('click', () => {
    const p = loadPrefs();
    p.sidebarCollapsed = !p.sidebarCollapsed;
    savePrefs();
    _el('arWorkspace')?.classList.toggle('is-sidebar-collapsed', p.sidebarCollapsed);
  });

  // Hide / In / Out flags
  document.querySelectorAll('[data-ar-hide]').forEach((cb) => {
    cb.addEventListener('change', () => {
      toggleFlag('hide', cb.dataset.arHide, cb.checked);
      applyTileVisibility();
    });
  });
  document.querySelectorAll('[data-ar-in]').forEach((cb) => {
    cb.addEventListener('change', () => toggleFlag('in', cb.dataset.arIn, cb.checked));
  });
  document.querySelectorAll('[data-ar-out]').forEach((cb) => {
    cb.addEventListener('change', () => toggleFlag('out', cb.dataset.arOut, cb.checked));
  });

  _el('btnArSend')?.addEventListener('click', sendToAgent);
  _el('arChatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendToAgent(); }
  });
  _el('btnArNewChat')?.addEventListener('click', () => {
    _chatHistory = [];
    renderChatLog();
  });

  _el('btnArFire')?.addEventListener('click', makeHotFire);
  _el('btnArSaveTrack')?.addEventListener('click', saveTrack);
  _el('btnArNewTrack')?.addEventListener('click', newTrack);
}

function applyTileVisibility() {
  const p = loadPrefs();
  Object.keys(AR_TILE_LABELS).forEach((key) => {
    const tile = document.querySelector(`[data-ar-tile="${key}"]`);
    if (tile) tile.classList.toggle('is-collapsed', !!p.hide[key]);
  });
}

// ── tags ─────────────────────────────────────────────────────────────────────

function readTags() {
  try {
    const v = JSON.parse(_el('arTags')?.value || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (_) { return []; }
}

function writeTags(list) {
  const known = list.filter((id) => AR_TAGS.some((t) => t.id === id));
  const el = _el('arTags');
  if (el) el.value = JSON.stringify(known);
  renderTagChips();
}

function renderTagChips() {
  const host = _el('arTagChips');
  if (!host) return;
  const active = readTags();
  host.innerHTML = AR_TAGS.map((t) => {
    const on = active.includes(t.id);
    return `<button type="button" class="ar-chip${on ? ' is-on' : ''}" data-ar-tag="${escapeHtml(t.id)}"
      data-help-title="${escapeHtml(t.helpTitle)}" data-help-text="${escapeHtml(t.helpText)}">${escapeHtml(t.label)}</button>`;
  }).join('');
  host.querySelectorAll('[data-ar-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.arTag;
      const cur = readTags();
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      writeTags(next);
      // The hidden input changed programmatically — fire the events the
      // delegated form-state capture listens for (Layer A does the saving).
      const el = _el('arTags');
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

// ── chat ─────────────────────────────────────────────────────────────────────

function renderChatLog() {
  const log = _el('arChatLog');
  if (!log) return;
  if (!_chatHistory.length) {
    log.innerHTML = '<div class="ar-chat-empty">No turns yet. Mark tiles <b>In</b> to give the agent context, <b>Out</b> to let it write them back.</div>';
    return;
  }
  log.innerHTML = _chatHistory.map((m) => {
    const who = m.role === 'user' ? 'you' : 'agent';
    return `<div class="ar-msg ar-msg-${escapeHtml(who)}"><span class="ar-msg-who">${who}</span><div class="ar-msg-body">${escapeHtml(m.content)}</div></div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function collectContext() {
  const p = loadPrefs();
  const parts = [];
  const read = {
    meta: () => `Title: ${_el('arTitle')?.value || ''}\nDescription: ${_el('arDescription')?.value || ''}`,
    theory: () => `Tempo: ${_el('arTempo')?.value || ''} BPM\nSwing: ${_el('arSwing')?.value || ''}%\nKey: ${_el('arKey')?.value || 'N/A'}\nMeter: ${_el('arMeter')?.value || '4/4'}`,
    tags: () => `Tags: ${readTags().join(', ') || '(none)'}`,
    lyrics: () => `Lyrics:\n${_el('arLyrics')?.value || '(empty)'}`,
  };
  for (const key of Object.keys(AR_TILE_LABELS)) {
    if (!p.in[key]) continue;
    parts.push(`### ${AR_TILE_LABELS[key]}\n${read[key]()}`);
  }
  return parts.join('\n\n');
}

function writableIds() {
  const p = loadPrefs();
  return new Set(Object.entries(AR_CONTROL_TILES)
    .filter(([, tile]) => p.out[tile])
    .map(([id]) => id));
}

/** First balanced top-level {...} in a reply — models wrap JSON in prose. */
function parseJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function applyDelta(delta, allowed) {
  const applied = [];
  const rejected = [];
  for (const [id, value] of Object.entries(delta)) {
    const el = _el(id);
    if (!el) { rejected.push(id); continue; }
    if (!allowed.has(id)) { rejected.push(id); continue; }
    let next;
    if (Array.isArray(value)) next = JSON.stringify(value);
    else if (typeof value === 'string' || typeof value === 'number') next = String(value);
    else { rejected.push(id); continue; }
    if (id === 'arTempo') next = String(Math.min(200, Math.max(40, Number(next) || 95)));
    if (id === 'arSwing') next = String(Math.min(100, Math.max(0, Number(next) || 0)));
    el.value = next;
    // Fire both — Layer A's delegated capture then persists it (§5: no manual save).
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    applied.push(id);
  }
  renderTagChips();
  return { applied, rejected };
}

async function sendToAgent() {
  const input = _el('arChatInput');
  const message = (input?.value || '').trim();
  if (!message) return;

  const context = collectContext();
  const allowed = writableIds();
  const allowedList = [...allowed].join(', ');

  const prompt = [
    context ? `Workspace context (tiles marked In):\n${context}` : 'Workspace context: (no tiles marked In).',
    '',
    '---',
    PERLP_DIRECTIVE,
    '',
    `Director instruction: ${message}`,
    '',
    allowed.size
      ? `Return ONLY a JSON object keyed by control id, containing ONLY these tiles: ${allowedList}. No prose, no markdown fence.`
      : 'No tile is currently marked Out. Reply with plain conversational text — nothing you write can be applied.',
  ].join('\n');

  _chatHistory.push({ role: 'user', content: message });
  if (input) input.value = '';
  renderChatLog();

  const backend = _el('arBackend')?.value || 'grok';
  const res = await runOpWithCancel('agent_chat', {
    backend, skill: 'chat', message: prompt, history: _chatHistory.slice(0, -1), timeout_s: 300,
  }, { label: 'Agent…' });

  if (!res || res.ok === false) {
    const err = (res && res.error) || 'agent call failed';
    _chatHistory.push({ role: 'assistant', content: `[${err}]` });
    renderChatLog();
    logConsole(`[AI Rapper] agent_chat failed: ${err}`, 'error');
    return;
  }

  const reply = (res.stdout || (res.items && res.items[0] && res.items[0].content) || '').trim();
  _chatHistory.push({ role: 'assistant', content: reply });
  renderChatLog();

  const delta = parseJsonObject(reply);
  if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
    const { applied, rejected } = applyDelta(delta, allowed);
    logConsole(`[AI Rapper] applied ${applied.length} tile(s)${rejected.length ? `, ignored ${rejected.length} not-writable` : ''}.`);
  }
}

// ── produce ──────────────────────────────────────────────────────────────────

function _val(id, fallback = '') {
  const v = _el(id)?.value;
  return v === undefined || v === null ? fallback : v;
}

function _promptFromTiles() {
  const desc = String(_val('arDescription')).trim();
  const title = String(_val('arTitle')).trim();
  if (desc) return desc;
  if (title) return `${title}, boom bap rap`;
  return 'boom bap rap, gritty loop, tight snare, dirty kick';
}

async function makeHotFire() {
  const tempo = Number(_val('arTempo', '95')) || 95;
  const swing = Number(_val('arSwing', '0')) || 0;
  const key = String(_val('arKey')).trim();
  const meter = String(_val('arMeter', '4/4')).trim() || '4/4';

  let prompt = _promptFromTiles();
  if (swing > 0) prompt += `, ${Math.round(swing)}% swing`;

  const body = {
    prompt,
    lyrics: String(_val('arLyrics')) || '[Instrumental]',
    seed: Number(_val('arSeed', '42')) || 42,
    duration_sec: Number(_val('arDuration', '20')) || 20,
    model: String(_val('arModel', 'acestep-v15-sft')),
    bpm: String(tempo),
    key,
    timesig: meter,
  };

  const res = await runOpWithCancel('music_generate', body, { label: 'Make Hot Fire…' });
  if (!res || res.ok === false) {
    logConsole(`[AI Rapper] music_generate failed: ${(res && res.error) || 'unknown error'}`, 'error');
    return;
  }
  const outPath = res.output_path || (res.outputs && res.outputs[0]);
  if (outPath) {
    try {
      await addPathsToPool([outPath]);
      logConsole(`[AI Rapper] WAV → pool: ${outPath}`);
    } catch (err) {
      logConsole(`[AI Rapper] generated but could not add to pool: ${err.message}`, 'error');
    }
  } else {
    logConsole('[AI Rapper] music_generate returned no output_path.', 'error');
  }
}

// ── track library (Layer B) ──────────────────────────────────────────────────

function collectTrackBody() {
  return {
    title: String(_val('arTitle')),
    description: String(_val('arDescription')),
    lyrics: String(_val('arLyrics')),
    tags: readTags(),
    tempo: Number(_val('arTempo', '95')) || 95,
    key: String(_val('arKey')),
    swing: Number(_val('arSwing', '0')) || 0,
    meter: String(_val('arMeter', '4/4')) || '4/4',
  };
}

function _trackStatus(msg, isError = false) {
  const el = _el('arTrackStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
}

async function _api(path, options) {
  const res = await fetch(path, options);
  return res.json();
}

async function loadTracks() {
  try {
    const data = await _api('/api/airapper/tracks');
    _tracks = (data && data.tracks) || [];
  } catch (err) {
    _tracks = [];
    _trackStatus(`Could not load saved songs: ${err.message}`, true);
  }
  renderTracks();
}

function renderTracks() {
  const host = _el('arTrackList');
  if (!host) return;
  const count = _el('arTrackCount');
  if (count) count.textContent = _tracks.length ? `${_tracks.length} saved` : '';

  if (!_tracks.length) {
    host.innerHTML = '<div class="ar-track-empty">No saved songs yet. Write something and press <b>Save</b>.</div>';
    return;
  }

  // Server returns created_at descending. Never re-sort by title.length here —
  // CSS columns balance by column height, not by text length (§8).
  host.innerHTML = _tracks.map((t) => `
    <article class="ar-track${t.id === _currentTrackId ? ' is-current' : ''}" data-ar-track="${escapeHtml(t.id)}"
             data-help-title="${escapeHtml(t.title || 'Untitled')}"
             data-help-text="${escapeHtml(t.description || 'Click to load this song into the workspace tiles.')}">
      <div class="ar-track-title">${escapeHtml(t.title || 'Untitled')}</div>
      <div class="ar-track-meta">
        <span>${escapeHtml(String(t.tempo ?? '—'))} BPM</span>
        <span>${escapeHtml(t.key || '—')}</span>
        <span>${escapeHtml(t.meter || '4/4')}</span>
      </div>
      ${(t.tags || []).length ? `<div class="ar-track-tags">${t.tags.map((tag) => `<span class="ar-track-tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <button type="button" class="ar-track-del" data-ar-del="${escapeHtml(t.id)}"
              data-help-title="Delete this song"
              data-help-text="Removes it from the saved-song library. The workspace tiles are untouched.">✕</button>
    </article>`).join('');

  host.querySelectorAll('[data-ar-track]').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-ar-del]')) return;
      openTrack(card.dataset.arTrack);
    });
  });
  host.querySelectorAll('[data-ar-del]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteTrack(btn.dataset.arDel);
    });
  });
}

function _setTile(id, value) {
  const el = _el(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function openTrack(id) {
  try {
    const data = await _api(`/api/airapper/tracks/${encodeURIComponent(id)}`);
    if (!data || !data.ok) {
      _trackStatus((data && data.error) || 'Track not found', true);
      return;
    }
    const t = data.track || {};
    _currentTrackId = t.id || id;
    _setTile('arTitle', t.title || '');
    _setTile('arDescription', t.description || '');
    _setTile('arLyrics', t.lyrics || '');
    _setTile('arTempo', String(t.tempo ?? 95));
    _setTile('arSwing', String(t.swing ?? 0));
    _setTile('arKey', t.key || '');
    _setTile('arMeter', t.meter || '4/4');
    writeTags(Array.isArray(t.tags) ? t.tags : []);
    renderTracks();
    _trackStatus(`Loaded "${t.title || 'Untitled'}"`);
  } catch (err) {
    _trackStatus(`Could not open track: ${err.message}`, true);
  }
}

async function saveTrack() {
  const body = collectTrackBody();
  if (!body.title && !body.lyrics) {
    _trackStatus('Nothing to save — give the track a title or some lyrics.', true);
    return;
  }
  try {
    const data = await _api('/api/airapper/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_currentTrackId ? { ...body, id: _currentTrackId } : body),
    });
    if (!data || !data.ok) {
      _trackStatus((data && data.error) || 'Save failed', true);
      return;
    }
    _currentTrackId = (data.track && data.track.id) || _currentTrackId;
    _trackStatus(data.created ? `Saved "${data.track.title || 'Untitled'}"` : 'Updated.');
    await loadTracks();
  } catch (err) {
    _trackStatus(`Save failed: ${err.message}`, true);
  }
}

async function deleteTrack(id) {
  try {
    const data = await _api(`/api/airapper/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!data || !data.ok) {
      _trackStatus((data && data.error) || 'Delete failed', true);
      return;
    }
    if (_currentTrackId === id) _currentTrackId = null;
    _trackStatus('Deleted.');
    await loadTracks();
  } catch (err) {
    _trackStatus(`Delete failed: ${err.message}`, true);
  }
}

function newTrack() {
  _currentTrackId = null;
  _setTile('arTitle', '');
  _setTile('arDescription', '');
  _setTile('arLyrics', '');
  writeTags([]);
  renderTracks();
  _trackStatus('New song — tiles cleared.');
}

export { collectTrackBody };