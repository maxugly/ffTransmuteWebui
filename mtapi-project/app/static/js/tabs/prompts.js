/**
 * Prompts Tab — Universal Prompt Library & Management Workspace.
 * Organize prompts by category (System, Audio, Image, Video, Lyrics, General).
 * Save, edit, tag, search, delete, and 1-click send prompts directly to target AI tabs.
 * Storage: localStorage key mtapi_prompt_library + mtapi_prompt_categories.
 */
import { state, elements, switchTab } from '/app.js?v=2';
import { escapeHtml } from '/js/utils.js';

const STORAGE_KEY = 'mtapi_prompt_library';
const CATEGORIES_KEY = 'mtapi_prompt_categories';

const DEFAULT_CATEGORIES = ['All', 'System', 'Audio', 'Image', 'Video', 'Lyrics', 'General'];

const SEED_PROMPTS = [
  {
    id: '__seed_recohere',
    name: 'Universal Recoherence',
    positive: '# Universal Recoherence\nA single coherent object, well-composed scene, centered, **sharp focus**, highly detailed, intricate details, volumetric lighting, masterpiece, best quality, *photorealistic*.\n\nSee documentation at https://github.com/ComposersDesktop/CDP8',
    negative: 'blurry, lowres, duplicate, double image, two images, split screen, collage, double exposure, ghosting, transparent, deformed, messy, incoherent, watermark, text',
    category: 'System',
    source_tab: 'riferecohere',
  },
  {
    id: '__seed_photoreal',
    name: 'Clean Photoreal',
    positive: '# Clean Photoreal\nPhotorealistic, highly detailed, sharp focus, 8k, professional lighting, `masterpiece`, *best quality*.\n\n- No artifacts\n- Natural skin tones\n- Reference: [SDXL Guide](https://huggingface.co/docs)',
    negative: 'blurry, low quality, distorted, deformed, ugly, bad anatomy, watermark, text',
    category: 'System',
    source_tab: 'seed',
  },
];

let currentCategory = 'All';
let searchQuery = '';

/**
 * Safe, vanilla Markdown to HTML formatter with hyperlink parsing.
 * Supports:
 * - HTML entity escaping for security
 * - Fenced code blocks ```lang ... ```
 * - Inline code `code`
 * - Headings: #, ##, ###, ####
 * - Bold: **text** and __text__
 * - Italic: *text* and _text_
 * - Unordered lists: - item, * item
 * - Markdown links: [text](https://example.com) -> <a target="_blank" rel="noopener">
 * - Bare URLs: https://... or http://... -> <a target="_blank" rel="noopener">
 * - Newlines to <br> or paragraphs
 */
export function renderMarkdownPrompt(text) {
  if (!text) return '';
  const str = String(text);

  // Split into fenced code blocks vs normal blocks
  const codeBlocks = [];
  let placeholderCount = 0;

  // Extract fenced code blocks first to protect their inner syntax
  const textWithoutBlocks = str.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const token = `__CODE_BLOCK_${placeholderCount++}__`;
    const escapedCode = escapeHtml(code.replace(/^\n+|\n+$/g, ''));
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push({
      token,
      html: `<pre style="background: rgba(0,0,0,0.45); border: 1px solid var(--panel-border, rgba(255,255,255,0.1)); border-radius: 4px; padding: 8px 12px; margin: 6px 0; overflow-x: auto; font-family: monospace; font-size: 0.85rem;"><code${langAttr}>${escapedCode}</code></pre>`
    });
    return token;
  });

  // Split lines
  const lines = textWithoutBlocks.split(/\r?\n/);
  const outLines = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check code block placeholder
    if (line.includes('__CODE_BLOCK_')) {
      if (inList) {
        outLines.push('</ul>');
        inList = false;
      }
      outLines.push(line);
      continue;
    }

    // List item (- or *)
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        outLines.push('<ul style="margin: 4px 0 6px 18px; padding: 0;">');
        inList = true;
      }
      const itemContent = formatInline(listMatch[2]);
      outLines.push(`<li style="margin-bottom: 2px;">${itemContent}</li>`);
      continue;
    } else if (inList) {
      outLines.push('</ul>');
      inList = false;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = formatInline(headingMatch[2]);
      const fontSizes = { 1: '1.15rem', 2: '1.05rem', 3: '0.95rem', 4: '0.9rem' };
      outLines.push(`<div style="font-weight: 700; font-size: ${fontSizes[level] || '1rem'}; margin: 8px 0 4px 0; color: var(--text-main, #eee);">${content}</div>`);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      outLines.push('<div style="height: 6px;"></div>');
      continue;
    }

    // Regular line
    outLines.push(`<div>${formatInline(line)}</div>`);
  }

  if (inList) {
    outLines.push('</ul>');
  }

  let finalHtml = outLines.join('');

  // Restore code blocks
  for (const block of codeBlocks) {
    finalHtml = finalHtml.replace(block.token, block.html);
  }

  return finalHtml;
}

/**
 * Format inline markdown: code, bold, italic, markdown links, auto-links.
 */
function formatInline(text) {
  if (!text) return '';

  // Escape HTML first
  let escaped = escapeHtml(text);

  // Inline code `...`
  const inlineCodes = [];
  let codeIdx = 0;
  escaped = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0001CODE${codeIdx++}\u0002`;
    inlineCodes.push({
      token,
      html: `<code style="background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 0.85em; color: #93c5fd;">${code}</code>`
    });
    return token;
  });

  // Bold **bold** or __bold__ (do before italic)
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic *italic* or _italic_
  escaped = escaped.replace(/(^|[^\w])\*([^*]+)\*([^\w]|$)/g, '$1<em>$2</em>$3');
  escaped = escaped.replace(/(^|[^\w])_([^_]+)_([^\w]|$)/g, '$1<em>$2</em>$3');

  // Markdown links: [label](url)
  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, (_, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: var(--primary, #3b82f6); text-decoration: underline; text-underline-offset: 2px;">${label}</a>`;
  });

  // Auto-link bare URLs (not preceded by href=" or >)
  escaped = escaped.replace(/(^|[^"'>])(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g, (_, prefix, url) => {
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: var(--primary, #3b82f6); text-decoration: underline; text-underline-offset: 2px;">${url}</a>`;
  });

  // Restore inline codes
  for (const item of inlineCodes) {
    escaped = escaped.replace(item.token, item.html);
  }

  return escaped;
}

function getStoredPrompts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let list = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    }
    
    // Seed initial items if completely empty or missing system category seeds
    if (list.length === 0) {
      list = SEED_PROMPTS.map(s => Object.assign({}, s, {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));
      saveStoredPrompts(list);
    } else {
      // Ensure seed prompts or older prompts have a category; if seed photoreal/recohere exist, assign System
      let modified = false;
      for (const p of list) {
        if (!p.category) {
          if (p.source_tab === 'seed' || p.source_tab === 'riferecohere' || p.id?.startsWith('__seed_')) {
            p.category = 'System';
            modified = true;
          } else {
            p.category = 'General';
            modified = true;
          }
        } else if ((p.id === '__seed_recohere' || p.id === '__seed_photoreal') && p.category !== 'System') {
          p.category = 'System';
          modified = true;
        }
      }
      if (modified) saveStoredPrompts(list);
    }

    return list;
  } catch (_) {
    return [];
  }
}

function saveStoredPrompts(prompts) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  } catch (e) {
    console.error('Failed to save prompts to localStorage', e);
  }
}

function renderPromptsForm() {
  const prompts = getStoredPrompts();
  
  // Filter by category and search
  const filtered = prompts.filter(p => {
    const catMatch = currentCategory === 'All' || (p.category || 'General').toLowerCase() === currentCategory.toLowerCase();
    const query = searchQuery.trim().toLowerCase();
    const textMatch = !query || 
      (p.name && p.name.toLowerCase().includes(query)) ||
      (p.positive && p.positive.toLowerCase().includes(query)) ||
      (p.negative && p.negative.toLowerCase().includes(query)) ||
      (p.notes && p.notes.toLowerCase().includes(query));
    return catMatch && textMatch;
  });

  const cardsHtml = filtered.length === 0 ? `
    <div class="empty-prompts-state" style="padding: 3rem; text-align: center; color: var(--text-dim, #888);">
      <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">No prompts found in <strong>${escapeHtml(currentCategory)}</strong> category.</p>
      <p style="font-size: 0.9rem;">Create a new prompt above or switch categories.</p>
    </div>
  ` : filtered.map(p => `
    <div class="prompt-entry-card" data-prompt-id="${escapeHtml(p.id)}" style="background: var(--panel-bg, #1a1e29); border: 1px solid var(--panel-border, rgba(255,255,255,0.08)); border-radius: 8px; padding: 14px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 0.75rem; text-transform: uppercase; background: var(--primary-glow, rgba(59,130,246,0.15)); color: var(--primary, #3b82f6); padding: 2px 8px; border-radius: 4px; font-weight: 600;">${escapeHtml(p.category || 'General')}</span>
          <strong style="font-size: 1.05rem; color: var(--text-main, #eee);">${escapeHtml(p.name || 'Untitled Prompt')}</strong>
        </div>
        <div style="display: flex; gap: 6px;">
          <button type="button" class="btn btn-sm btn-prompt-copy" data-id="${escapeHtml(p.id)}" data-help-title="Copy prompt text" data-help-text="Copy positive prompt to clipboard">Copy</button>
          <button type="button" class="btn btn-sm btn-prompt-send" data-id="${escapeHtml(p.id)}" data-help-title="Send to AI Tab" data-help-text="Load this prompt into the target AI tab">Send To...</button>
          <button type="button" class="btn btn-sm btn-prompt-del" data-id="${escapeHtml(p.id)}" style="color: #ef4444;" data-help-title="Delete prompt" data-help-text="Delete this prompt entry">✕</button>
        </div>
      </div>
      
      <div class="prompt-positive-formatted" style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main, #ddd); background: var(--bg-inset, #11141c); padding: 12px; border-radius: 6px; max-height: 240px; overflow-y: auto;">
        ${renderMarkdownPrompt(p.positive || '')}
      </div>

      ${p.negative ? `
        <div style="font-size: 0.8rem; color: #f87171; background: rgba(239,68,68,0.06); padding: 6px 10px; border-radius: 4px;">
          <strong>Negative:</strong> ${escapeHtml(p.negative)}
        </div>
      ` : ''}

      ${p.bpm || p.key ? `
        <div style="display: flex; gap: 8px; font-size: 0.8rem; color: var(--text-muted, #aaa);">
          ${p.bpm ? `<span><strong>BPM:</strong> ${escapeHtml(String(p.bpm))}</span>` : ''}
          ${p.key ? `<span><strong>Key:</strong> ${escapeHtml(String(p.key))}</span>` : ''}
        </div>
      ` : ''}
    </div>
  `).join('');

  const catButtons = DEFAULT_CATEGORIES.map(cat => `
    <button type="button" class="btn ${currentCategory === cat ? 'active' : ''} btn-cat-filter" data-cat="${escapeHtml(cat)}" style="${currentCategory === cat ? 'background: var(--primary, #3b82f6); color: #fff;' : ''}">${escapeHtml(cat)}</button>
  `).join('');

  elements.actionPanel.innerHTML = `
    <div class="prompts-workspace" style="max-width: 920px; margin: 0 auto; width: 100%; display: flex; flex-direction: column; gap: 14px;">
      
      <!-- Top Bar: Header & Add Drawer -->
      <div class="ref-card" style="background: var(--panel-bg, #1a1e29); border: 1px solid var(--panel-border, rgba(255,255,255,0.08)); border-radius: 8px; padding: 16px;">
        <h3 style="margin: 0 0 8px 0; font-size: 1.2rem;">Universal Prompt Library</h3>
        <p style="margin: 0 0 14px 0; font-size: 0.85rem; color: var(--text-muted, #aaa);">
          Save, manage, and dispatch prompts across all AI generation desks (Music, AI Rapper, Txt2Img, Img2Img, Video, FL Studio). Markdown formatting and clickable links supported.
        </p>

        <!-- New Prompt Input Form -->
        <div style="display: flex; flex-direction: column; gap: 10px; background: var(--bg-inset, #11141c); padding: 14px; border-radius: 6px;">
          <div style="display: flex; gap: 10px;">
            <input type="text" id="newPromptTitle" placeholder="Prompt Title (e.g. F# Minor Melodic Organ / Neo-Soul Chords)" style="flex: 2 1 14rem; padding: 6px 10px;" data-help-title="Prompt title" data-help-text="Name for this prompt entry">
            <select id="newPromptCategory" style="flex: 1 1 8rem; padding: 6px 10px;" data-help-title="Category" data-help-text="Classification category for this prompt">
              <option value="System">System</option>
              <option value="Audio">Audio</option>
              <option value="Image">Image</option>
              <option value="Video">Video</option>
              <option value="Lyrics">Lyrics</option>
              <option value="General">General</option>
            </select>
          </div>

          <textarea id="newPromptPositive" rows="3" placeholder="Enter positive prompt / musical instructions / markdown notes / links..." style="width: 100%; padding: 8px 10px; font-family: inherit; font-size: 0.9rem;" data-help-title="Positive prompt" data-help-text="Prompt text description or musical guidelines"></textarea>
          
          <div style="display: flex; gap: 10px;">
            <input type="text" id="newPromptNegative" placeholder="Negative prompt (optional — blurry, drums, dissonance...)" style="flex: 2 1 14rem; padding: 6px 10px;" data-help-title="Negative prompt" data-help-text="Excluded characteristics or negative constraints">
            <input type="text" id="newPromptKey" placeholder="Key (optional, e.g. F#m)" style="flex: 1 1 5rem; padding: 6px 10px;" data-help-title="Key" data-help-text="Musical key or scale (optional)">
            <input type="text" id="newPromptBpm" placeholder="BPM (optional)" style="flex: 1 1 5rem; padding: 6px 10px;" data-help-title="BPM" data-help-text="Tempo BPM (optional)">
            <button type="button" class="btn" id="btnSaveNewPrompt" style="background: var(--primary, #3b82f6); color: #fff; padding: 6px 16px; font-weight: 600;" data-help-title="Save Prompt" data-help-text="Save prompt into library">Save to Library</button>
          </div>
        </div>
      </div>

      <!-- Filter & Search Toolbar -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          ${catButtons}
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="promptsSearchInput" value="${escapeHtml(searchQuery)}" placeholder="Search prompts..." style="padding: 6px 10px; width: 220px;" data-help-title="Search" data-help-text="Filter prompts by title, description or notes">
        </div>
      </div>

      <!-- Prompts List Cards -->
      <div id="promptsListContainer">
        ${cardsHtml}
      </div>

    </div>
  `;

  bindPromptsEvents();
}

function bindPromptsEvents() {
  // Category filter buttons
  elements.actionPanel.querySelectorAll('.btn-cat-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      currentCategory = btn.getAttribute('data-cat') || 'All';
      renderPromptsForm();
    });
  });

  // Search input
  const searchInput = document.getElementById('promptsSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderPromptsForm();
    });
  }

  // Save prompt button
  const saveBtn = document.getElementById('btnSaveNewPrompt');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const title = (document.getElementById('newPromptTitle')?.value || '').trim();
      const pos = (document.getElementById('newPromptPositive')?.value || '').trim();
      const neg = (document.getElementById('newPromptNegative')?.value || '').trim();
      const cat = document.getElementById('newPromptCategory')?.value || 'System';
      const key = (document.getElementById('newPromptKey')?.value || '').trim();
      const bpm = (document.getElementById('newPromptBpm')?.value || '').trim();

      if (!pos && !title) {
        alert('Please provide a prompt title or text.');
        return;
      }

      const prompts = getStoredPrompts();
      const newEntry = {
        id: 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        name: title || (pos.slice(0, 40) + '...'),
        positive: pos,
        negative: neg,
        category: cat,
        key: key || undefined,
        bpm: bpm || undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      prompts.unshift(newEntry);
      saveStoredPrompts(prompts);
      renderPromptsForm();
    });
  }

  // Copy buttons
  elements.actionPanel.querySelectorAll('.btn-prompt-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const prompts = getStoredPrompts();
      const p = prompts.find(x => x.id === id);
      if (p && p.positive) {
        navigator.clipboard.writeText(p.positive).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      }
    });
  });

  // Delete buttons
  elements.actionPanel.querySelectorAll('.btn-prompt-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (confirm('Delete this prompt?')) {
        let prompts = getStoredPrompts();
        prompts = prompts.filter(x => x.id !== id);
        saveStoredPrompts(prompts);
        renderPromptsForm();
      }
    });
  });

  // Send to AI tab button
  elements.actionPanel.querySelectorAll('.btn-prompt-send').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const prompts = getStoredPrompts();
      const p = prompts.find(x => x.id === id);
      if (!p) return;

      const cat = (p.category || '').toLowerCase();
      let targetTab = 'music';
      if (cat === 'image') targetTab = 'txt2img';
      else if (cat === 'video') targetTab = 'rife';
      else if (cat === 'lyrics') targetTab = 'airapper';

      // Pre-fill target state
      if (targetTab === 'music') {
        state.music = Object.assign({}, state.music, {
          prompt: p.positive,
          bpm: p.bpm || (state.music || {}).bpm || '',
          key: p.key || (state.music || {}).key || ''
        });
      }
      switchTab(targetTab);
    });
  });
}

export { renderPromptsForm };
