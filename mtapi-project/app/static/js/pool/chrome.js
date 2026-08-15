// Pool chrome — tile zoom, info menu, context menu, file browser, format helpers
import { state, elements, ensureTileInfo, switchTab, checkHealth } from '/app.js';
import { POOL_ZOOM, TILE_INFO_FIELDS } from '/js/pool/constants.js';
import { escapeHtml } from '/js/utils.js';
import { buildPoolMetaHtml, scheduleSavePoolState } from '/js/pool/persistence.js';
import { sendPoolPathTo } from '/js/pool/items.js';
import { quickTransmuteLabel } from '/js/tabs/quick.js';
import { addMultiClipPath } from '/js/tabs/transmute.js';
import { logConsole } from '/js/preview.js';

// ── Tile zoom + info menu ─────────────────────────────────────────────────

function setPoolZoom(px) {
  const clamped = Math.max(POOL_ZOOM.min, Math.min(POOL_ZOOM.max, Math.round(px)));
  state.pool.tileZoom = clamped;
  applyPoolZoom();
  scheduleSavePoolState();
}

function applyPoolZoom() {
  const grid = document.getElementById('poolGrid');
  if (!grid) return;
  const z = state.pool.tileZoom || POOL_ZOOM.reset;
  grid.style.setProperty('--pool-tile-min', `${z}px`);
  grid.dataset.zoom = String(z);
  try {
    window.__mtapiVirtualGrid?.invalidate?.();
    window.__mtapiVirtualGrid?.sync?.({ force: true });
    window.__mtapiImageVirtualGrid?.invalidate?.();
    window.__mtapiImageVirtualGrid?.sync?.({ force: true });
  } catch (_) { /* ignore */ }
  // Mark reset button
  document.querySelectorAll('.pool-zoom-btn').forEach(btn => btn.classList.remove('active'));
  if (z === POOL_ZOOM.reset) {
    document.getElementById('btnZoomReset')?.classList.add('active');
  } else if (z <= POOL_ZOOM.min) {
    document.getElementById('btnZoomMin')?.classList.add('active');
  } else if (z >= POOL_ZOOM.max) {
    document.getElementById('btnZoomMax')?.classList.add('active');
  }
}

function setupTileInfoMenu() {
  const btn = document.getElementById('btnTileInfoMenu');
  const menu = document.getElementById('tileInfoMenu');
  const checks = document.getElementById('tileInfoChecks');
  if (!btn || !menu || !checks) return;

  ensureTileInfo();
  checks.innerHTML = TILE_INFO_FIELDS.map(f => `
    <label class="pool-info-check">
      <input type="checkbox" data-tile-info="${f.key}" ${state.pool.tileInfo[f.key] ? 'checked' : ''}>
      <span>${escapeHtml(f.label)}</span>
    </label>
  `).join('');

  const closeMenu = () => {
    menu.hidden = true;
    state.pool.tileInfoMenuOpen = false;
  };
  const openMenu = () => {
    menu.hidden = false;
    state.pool.tileInfoMenuOpen = true;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  checks.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.tileInfo;
      state.pool.tileInfo[key] = cb.checked;
      refreshPoolTileOverlays();
      scheduleSavePoolState();
    });
  });

  document.getElementById('btnTileInfoAll')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = true; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = true; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });
  document.getElementById('btnTileInfoNone')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = false; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = false; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });

  // Close on outside click (once per form render — use capture on document)
  const onDoc = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeMenu();
    }
  };
  // Remove previous listener if re-rendered
  if (window._poolInfoMenuDocHandler) {
    document.removeEventListener('click', window._poolInfoMenuDocHandler);
  }
  window._poolInfoMenuDocHandler = onDoc;
  document.addEventListener('click', onDoc);

  menu.addEventListener('click', (e) => e.stopPropagation());
}

function refreshPoolTileOverlays() {
  // Rebuild overlays + frame labels without full grid re-fetch
  const info = ensureTileInfo();
  state.pool.items.forEach((item, idx) => {
    const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === item.path);
    if (!card) return;

    // Frame labels
    card.querySelectorAll('.pool-frame').forEach((frameEl, fi) => {
      let label = frameEl.querySelector('.pool-frame-label');
      if (info.frame_labels) {
        if (!label) {
          label = document.createElement('span');
          label.className = 'pool-frame-label';
          label.textContent = fi === 0 ? 'FIRST' : 'LAST';
          frameEl.appendChild(label);
        }
      } else if (label) {
        label.remove();
      }
    });

    const metaHtml = item.meta || item.metaError
      ? buildPoolMetaHtml(item)
      : (item.metaError ? buildPoolMetaHtml(item) : null);

    let overlay = card.querySelector('.pool-overlay');
    let metaEl = document.getElementById(`poolMeta-${idx}`);

    if (!item.meta && !item.metaError) {
      if (metaEl) metaEl.innerHTML = '<span class="pool-meta-unavailable">metadata unavailable</span>';
      return;
    }

    if (!metaHtml || !metaHtml.trim()) {
      if (overlay) overlay.remove();
      // keep hidden anchor for future updates
      if (!metaEl) {
        metaEl = document.createElement('div');
        metaEl.id = `poolMeta-${idx}`;
        metaEl.style.display = 'none';
        card.appendChild(metaEl);
      } else {
        metaEl.style.display = 'none';
        metaEl.innerHTML = '';
      }
      return;
    }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pool-overlay';
      overlay.innerHTML = `<div class="pool-overlay-text" id="poolMeta-${idx}"></div>`;
      card.appendChild(overlay);
      metaEl = overlay.querySelector('.pool-overlay-text');
    }
    if (metaEl) {
      metaEl.style.display = '';
      metaEl.innerHTML = metaHtml;
    }
  });
}


// Close any open Send-to menus on outside click
document.addEventListener('click', (e) => {
  if (e.target.closest('.pool-send-wrap')) return;
  document.querySelectorAll('.pool-send-menu:not([hidden])').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.pool-card.menu-open').forEach(c => c.classList.remove('menu-open'));
  if (!e.target.closest('.pool-ctx-menu')) hidePoolContextMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePoolContextMenu();
});

// ── Pool right-click context menu ─────────────────────────────────────────

function hidePoolContextMenu() {
  const m = document.getElementById('poolCtxMenu');
  if (m) m.remove();
}

function showPoolContextMenu(x, y, path) {
  hidePoolContextMenu();
  const menu = document.createElement('div');
  menu.id = 'poolCtxMenu';
  menu.className = 'pool-ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" class="pool-ctx-item pool-ctx-quick" data-act="quick">${escapeHtml(quickTransmuteLabel())}</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item" data-act="sequence">Add to sequence</button>
    <button type="button" class="pool-ctx-item" data-act="preview">Preview</button>
    <button type="button" class="pool-ctx-item" data-act="mosh">Send → Datamosh</button>
    <button type="button" class="pool-ctx-item" data-act="deepdream">Send → DeepDream</button>
    <button type="button" class="pool-ctx-item" data-act="rife">Send → RIFE</button>
    <button type="button" class="pool-ctx-item" data-act="speedchange">Send → Speed Change</button>
    <button type="button" class="pool-ctx-item" data-act="upscale">Send → Upscale</button>
    <button type="button" class="pool-ctx-item" data-act="fastsam">Send → FastSAM</button>
    <button type="button" class="pool-ctx-item" data-act="convert">Send → Convert / Export</button>
    <button type="button" class="pool-ctx-item" data-act="transmute">Send → Transmute</button>
    <button type="button" class="pool-ctx-item" data-act="multi">Send → Multi</button>
    <button type="button" class="pool-ctx-item" data-act="advanced">Send → Raw CLI</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item" data-act="save_first_png">Save first frame PNG…</button>
    <button type="button" class="pool-ctx-item" data-act="save_last_png">Save last frame PNG…</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item pool-ctx-muted" data-act="quick_setup">Configure Quick Transmute…</button>
  `;
  document.body.appendChild(menu);

  // Position, clamp to viewport
  const pad = 6;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll('.pool-ctx-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      hidePoolContextMenu();
      if (act === 'quick_setup') {
        switchTab('quick');
        return;
      }
      sendPoolPathTo(path, act);
    });
  });
}

// File Browser Logic
// mode: 'file' | 'files' | 'file_save' | 'dir'
// filter: 'video' | 'image' | 'project' | 'all' (passed to /api/picker)
window.openFileBrowser = async function(targetInputId, selectDirOnly = false, mode = 'file', filter = null) {
  let pickerMode = 'file';
  if (selectDirOnly) pickerMode = 'dir';
  else if (mode === 'file_save') pickerMode = 'save';
  else if (mode === 'dir') pickerMode = 'dir';
  else if (mode === 'files') pickerMode = 'files';

  // Infer filter from target when not specified
  let fileFilter = filter;
  if (!fileFilter) {
    if (targetInputId === 'hijackImagePath') fileFilter = 'image';
    else if (mode === 'file_save' || pickerMode === 'save') fileFilter = 'video';
    else if (pickerMode === 'dir') fileFilter = 'all';
    else fileFilter = 'video';
  }
  
  let startPath = '';
  if (targetInputId !== 'addMultiClip') {
    const currentVal = document.getElementById(targetInputId)?.value;
    if (currentVal && currentVal.startsWith('/')) {
      startPath = currentVal.substring(0, currentVal.lastIndexOf('/'));
    }
  }

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for file picker...';
  
  try {
    const url = `/api/picker?mode=${pickerMode}`
      + `&start_path=${encodeURIComponent(startPath)}`
      + `&filter=${encodeURIComponent(fileFilter)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    if (pickerMode === 'files' && data.paths && data.paths.length) {
      const input = document.getElementById(targetInputId);
      if (input) {
        input.value = data.paths.join('\n');
        input.dispatchEvent(new Event('input'));
      }
      logConsole('[PICKED]: ' + data.paths.length + ' file(s)');
    } else if (data.path) {
      if (targetInputId === 'addMultiClip') {
        addMultiClipPath(data.path);
      } else {
        const input = document.getElementById(targetInputId);
        if (input) {
          input.value = data.path;
          input.dispatchEvent(new Event('input'));
        }
      }
      logConsole(`[PICKED]: ${data.path}`);
    } else {
      logConsole(`[PICKER]: Cancelled by user`);
    }
  } catch (err) {
    logConsole(`[PICKER ERROR]: ${err.message}`);
    alert(`Could not open system file picker. Make sure kdialog is running or enter path manually.`);
  } finally {
    await checkHealth();
  }
};

function closeFbModal() {
  elements.fbModal.classList.remove('active');
}

async function browsePath(path = '') {
  try {
    const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    state.fb.currentPath = data.current_path;
    elements.fbPathInput.value = data.current_path;
    
    // Render Shortcuts
    elements.fbShortcuts.innerHTML = '';
    data.shortcuts.forEach(shortcut => {
      const btn = document.createElement('button');
      btn.className = 'fb-shortcut-btn';
      btn.textContent = shortcut.name;
      btn.addEventListener('click', () => browsePath(shortcut.path));
      elements.fbShortcuts.appendChild(btn);
    });

    // Render List
    elements.fbList.innerHTML = '';
    
    // Parent Directory ".."
    if (data.parent_path) {
      const parentItem = document.createElement('li');
      parentItem.className = 'fb-item fb-up-btn';
      parentItem.innerHTML = `
        <span class="fb-item-icon">📁</span>
        <span class="fb-item-name">.. (Go Up)</span>
      `;
      parentItem.addEventListener('click', () => browsePath(data.parent_path));
      elements.fbList.appendChild(parentItem);
    }

    if (data.entries.length === 0) {
      elements.fbList.innerHTML += `<li class="fb-empty">Folder is empty</li>`;
      return;
    }

    data.entries.forEach(entry => {
      // If selectDirOnly is true, we still list files but make them unselectable
      const isDir = entry.is_dir;
      const isSelected = state.fb.selectedPath === entry.path;
      
      const li = document.createElement('li');
      li.className = `fb-item ${isSelected ? 'selected' : ''}`;
      
      let icon = isDir ? '📁' : '📄';
      if (!isDir) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        if (['.mp4', '.m4v', '.mov', '.avi', '.mkv'].includes(ext)) icon = '🎬';
        else if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) icon = '🖼️';
        else if (['.m4a', '.mp3', '.wav'].includes(ext)) icon = '🎵';
      }

      const sizeText = entry.size !== null ? formatBytes(entry.size) : '';

      li.innerHTML = `
        <span class="fb-item-icon ${isDir ? 'dir' : 'file'}">${icon}</span>
        <span class="fb-item-name">${entry.name}</span>
        <span class="fb-item-size">${sizeText}</span>
      `;
      
      // Double click navigates into directory
      li.addEventListener('dblclick', () => {
        if (isDir) {
          browsePath(entry.path);
        }
      });
      
      // Single click selects
      li.addEventListener('click', () => {
        // Toggle selected state
        document.querySelectorAll('.fb-item').forEach(el => el.classList.remove('selected'));
        
        if (state.fb.selectDirOnly && !isDir) {
          // Can't select file in directory-only mode
          state.fb.selectedPath = '';
          state.fb.selectedName = '';
          state.fb.selectedIsDir = false;
          return;
        }

        li.classList.add('selected');
        state.fb.selectedPath = entry.path;
        state.fb.selectedName = entry.name;
        state.fb.selectedIsDir = isDir;
      });

      elements.fbList.appendChild(li);
    });

  } catch (err) {
    logConsole(`[BROWSE ERROR]: ${err.message}`);
  }
}

function navigateUpFb() {
  // Simple extraction of parent path
  const current = state.fb.currentPath;
  if (!current) return;
  const lastIndex = current.lastIndexOf('/');
  if (lastIndex > 0) {
    const parent = current.substring(0, lastIndex);
    browsePath(parent);
  } else if (lastIndex === 0) {
    browsePath('/');
  }
}

function confirmFbSelection() {
  let finalPath = '';
  
  if (state.fb.resolveMode === 'file_save') {
    if (state.fb.selectedPath && !state.fb.selectedIsDir) {
      finalPath = state.fb.selectedPath;
    } else {
      const filename = prompt("Enter output filename (e.g. output.mp4):", "output.mp4");
      if (!filename) return; // cancel
      finalPath = state.fb.currentPath + '/' + filename;
    }
  } else {
    if (!state.fb.selectedPath) {
      if (state.fb.selectDirOnly) {
        finalPath = state.fb.currentPath;
      } else {
        alert("Please select a file.");
        return;
      }
    } else {
      finalPath = state.fb.selectedPath;
    }
  }
  
  if (state.fb.targetInputId === 'addMultiClip') {
    addMultiClipPath(finalPath);
  } else {
    const input = document.getElementById(state.fb.targetInputId);
    if (input) {
      input.value = finalPath;
      input.dispatchEvent(new Event('input'));
    }
  }
  
  closeFbModal();
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export {
  setPoolZoom, applyPoolZoom,
  setupTileInfoMenu, refreshPoolTileOverlays,
  hidePoolContextMenu, showPoolContextMenu,
  closeFbModal, browsePath, navigateUpFb, confirmFbSelection,
  formatBytes,
};
