/**
 * Custom vanilla DOM virtualizer for catalog cards.
 *
 * Scroll parent: .pool-grid-wrap
 * Canvas:        .pool-scroll-canvas
 * Cards:         direct-child .pool-card (absolute + translate3d)
 *
 * Scroll path is transform + dataset only. Full card content is filled when
 * the path changes and after scroll idle. Recycled nodes stay in the canvas.
 */

const OVERSCAN_SCREENS = 1.5;
const GAP = 8;
const CREATE_BUDGET = 8;
const WORK_SAMPLES = 120;

function _colsFor(width, minCol) {
  const inner = Math.max(1, width);
  return Math.max(1, Math.floor((inner + GAP) / (minCol + GAP)));
}

function createVirtualGrid({
  wrap,
  canvas,
  getItems,
  renderCard,
  recycleCard,
  bindCard,
  onWindow,
  minColWidth = 200,
  overscanScreens = OVERSCAN_SCREENS,
} = {}) {
  const cards = new Map();
  const free = [];
  const parkFrag = document.createDocumentFragment();
  let layout = { cols: 1, cardW: minColWidth, cardH: minColWidth * 9 / 16, totalH: 0, start: 0, end: 0 };
  let raf = 0;
  let idleTimer = 0;
  let lastItems = [];
  let destroyed = false;
  let firstPaintMarked = false;
  let measureKey = '';
  let syncing = false;
  let ro = null;
  let lastWinKey = '';
  const workSamples = [];
  let lastWorkMs = 0;
  let scrolling = false;

  function measure() {
    if (!wrap || !canvas) return layout;
    const widthNow = wrap.clientWidth;
    const cssMin = parseFloat(canvas.style.getPropertyValue('--pool-tile-min'))
      || parseFloat(getComputedStyle(canvas).getPropertyValue('--pool-tile-min'))
      || minColWidth;
    const key = `${Math.round(widthNow / 24) * 24}:${cssMin}`;
    if (key === measureKey && layout.cardW) return layout;
    measureKey = key;
    const padL = 6;
    const padR = 6;
    const width = Math.max(1, widthNow - padL - padR);
    const minCol = Number(cssMin) || Number(minColWidth) || 200;
    const cols = _colsFor(width, minCol);
    const cardW = Math.max(40, (width - GAP * (cols - 1)) / cols);
    const cardH = Math.max(cardW * 9 / 16, 72);
    layout = { ...layout, cols, cardW, cardH, width };
    return layout;
  }

  function windowRange(itemCount) {
    const viewH = Math.max(120, Math.min(wrap.clientHeight || 120, (typeof window !== 'undefined' ? window.innerHeight : 1080) || 1080));
    const overscanPx = viewH * overscanScreens;
    const scrollTop = wrap.scrollTop || 0;
    const rowH = layout.cardH + GAP;
    const visStartY = scrollTop;
    const visEndY = scrollTop + viewH;
    const startY = Math.max(0, visStartY - overscanPx / 2);
    const endY = visEndY + overscanPx / 2;
    const startRow = Math.floor(startY / rowH);
    const endRow = Math.ceil(endY / rowH);
    const visStartRow = Math.floor(visStartY / rowH);
    const visEndRow = Math.ceil(visEndY / rowH);
    const start = Math.max(0, startRow * layout.cols);
    const end = Math.min(itemCount, endRow * layout.cols);
    const visStart = Math.max(0, visStartRow * layout.cols);
    const visEnd = Math.min(itemCount, visEndRow * layout.cols);
    const limit = Math.max(end - start, 0);
    return { start, end, limit, viewH, overscanPx, visStart, visEnd };
  }

  function positionCard(el, index) {
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    const x = col * (layout.cardW + GAP);
    const y = row * (layout.cardH + GAP);
    el.style.width = `${layout.cardW}px`;
    el.style.height = `${layout.cardH}px`;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function createCard() {
    const el = document.createElement('article');
    el.className = 'pool-card';
    el.draggable = true;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.willChange = 'transform';
    if (typeof bindCard === 'function') bindCard(el);
    return el;
  }

  function acquireCard() {
    if (free.length) return free.pop();
    return createCard();
  }

  function parkCard(el) {
    el.dataset.path = '';
    el.dataset.hash = '';
    el.dataset.idx = '';
    el.classList.remove('selected', 'hovered', 'seq-active', 'dragging', 'menu-open');
    el.style.transform = 'translate3d(-10000px, 0, 0)';
    el.style.pointerEvents = 'none';
    parkFrag.appendChild(el);
    free.push(el);
  }

  function recordWork(ms) {
    lastWorkMs = ms;
    workSamples.push(ms);
    if (workSamples.length > WORK_SAMPLES) workSamples.shift();
  }

  function sync({ force = false, lite = false } = {}) {
    if (destroyed || !wrap || !canvas || syncing) return layout;
    const t0 = performance.now();
    syncing = true;
    try {
      return _syncBody({ force, lite });
    } finally {
      syncing = false;
      recordWork(performance.now() - t0);
    }
  }

  function _syncBody({ force, lite }) {
    measure();
    const items = getItems() || [];
    lastItems = items;
    const n = items.length;
    const rows = n ? Math.ceil(n / layout.cols) : 0;
    const totalH = rows ? rows * layout.cardH + Math.max(0, rows - 1) * GAP : 0;
    if (layout.totalH !== totalH) {
      layout.totalH = totalH;
      canvas.style.height = `${totalH}px`;
      canvas.style.position = 'relative';
    }

    if (!n) {
      for (const [p, el] of cards) {
        parkCard(el);
        cards.delete(p);
      }
      layout.start = 0;
      layout.end = 0;
      lastWinKey = '';
      return layout;
    }

    const win = windowRange(n);
    const winKey = `${win.start}:${win.end}:${layout.cols}:${layout.cardW}`;
    if (!force && winKey === lastWinKey) return layout;
    lastWinKey = winKey;
    layout.start = win.start;
    layout.end = win.end;
    const warm = Math.min(Math.max(win.limit, 1), 96);
    while (cards.size + free.length < warm) parkCard(createCard());

    const keep = new Set();
    let created = 0;
    let deferred = false;
    const order = [];
    for (let i = win.visStart; i < win.visEnd; i++) order.push(i);
    for (let i = win.start; i < win.end; i++) {
      if (i < win.visStart || i >= win.visEnd) order.push(i);
    }

    const paint = (lite && typeof recycleCard === 'function') ? recycleCard : renderCard;
    // Lite recycle is cheap (placeholder / cached decode). Do not leave
    // visible-window holes during fast scroll or scrollbar jumps.
    const createCap = lite ? Number.POSITIVE_INFINITY : CREATE_BUDGET;

    for (const i of order) {
      const item = items[i];
      if (!item || !item.path) continue;
      keep.add(item.path);
      let el = cards.get(item.path);
      if (!el) {
        if (created >= createCap && !force) {
          deferred = true;
          keep.delete(item.path);
          continue;
        }
        el = acquireCard();
        el.style.pointerEvents = '';
        if (el.parentNode !== canvas) canvas.appendChild(el);
        cards.set(item.path, el);
        if (typeof paint === 'function') paint(el, item, i);
        created += 1;
      } else if (force && typeof renderCard === 'function') {
        renderCard(el, item, i);
      } else if (lite && typeof recycleCard === 'function' && el.dataset.path !== item.path) {
        recycleCard(el, item, i);
      }
      el.dataset.idx = String(i);
      positionCard(el, i);
    }

    for (const [p, el] of cards) {
      if (!keep.has(p)) {
        parkCard(el);
        cards.delete(p);
      }
    }

    let holes = 0;
    for (let i = win.visStart; i < win.visEnd; i++) {
      const it = items[i];
      if (it && it.path && !cards.has(it.path)) holes += 1;
    }

    if (typeof onWindow === 'function') {
      const windowItems = [];
      for (let i = win.start; i < win.end; i++) {
        if (items[i]) windowItems.push(items[i]);
      }
      try { onWindow(windowItems, { holes }); } catch (_) { /* ignore */ }
    }

    if (!firstPaintMarked && cards.size > 0) {
      firstPaintMarked = true;
      try { performance.mark('firstVisibleCard'); } catch (_) { /* ignore */ }
    }
    if (deferred) requestSync();
    return layout;
  }

  function requestSync() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync({ lite: scrolling });
    });
  }

  function onScroll() {
    scrolling = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      scrolling = false;
      idleTimer = 0;
      sync({ force: true, lite: false });
    }, 80);
    const n = lastItems.length;
    if (n) {
      measure();
      const win = windowRange(n);
      if (`${win.start}:${win.end}:${layout.cols}:${layout.cardW}` === lastWinKey) return;
    }
    requestSync();
  }

  function onResize() {
    lastWinKey = '';
    requestSync();
  }

  function cardForPath(path) {
    return cards.get(path) || null;
  }

  function indexOfPath(path) {
    return lastItems.findIndex((it) => it.path === path);
  }

  function itemAtIndex(i) {
    return lastItems[i] || null;
  }

  function indexFromPoint(clientX, clientY) {
    if (!wrap) return -1;
    const rect = wrap.getBoundingClientRect();
    const x = clientX - rect.left + wrap.scrollLeft - 6;
    const y = clientY - rect.top + wrap.scrollTop - 8;
    if (x < 0 || y < 0) return -1;
    const col = Math.floor(x / (layout.cardW + GAP));
    const row = Math.floor(y / (layout.cardH + GAP));
    if (col < 0 || col >= layout.cols || row < 0) return -1;
    const idx = row * layout.cols + col;
    return idx >= 0 && idx < lastItems.length ? idx : -1;
  }

  function scrollToPath(path, { behavior = 'auto', block = 'center' } = {}) {
    const idx = indexOfPath(path);
    if (idx < 0) return;
    const row = Math.floor(idx / layout.cols);
    const y = row * (layout.cardH + GAP);
    const viewH = wrap.clientHeight || 0;
    let top = y;
    if (block === 'center') top = Math.max(0, y - (viewH - layout.cardH) / 2);
    wrap.scrollTo({ top, behavior });
    lastWinKey = '';
    sync({ force: true });
  }

  function getScrollTop() {
    return wrap ? wrap.scrollTop : 0;
  }

  function setScrollTop(v) {
    if (wrap) wrap.scrollTop = Number(v) || 0;
    lastWinKey = '';
    sync({ force: true });
  }

  function refreshPath(path) {
    const el = cards.get(path);
    if (!el) return;
    const idx = indexOfPath(path);
    const item = idx >= 0 ? lastItems[idx] : null;
    if (item && typeof renderCard === 'function') renderCard(el, item, idx);
  }

  function refreshAllVisible() {
    lastWinKey = '';
    sync({ force: true, lite: false });
  }

  function invalidate() {
    lastWinKey = '';
    measureKey = '';
  }

  function stats() {
    const n = lastItems.length;
    const win = n ? windowRange(n) : { start: 0, end: 0, limit: 0 };
    const sorted = workSamples.slice().sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
      : 0;
    return {
      items: n,
      mounted: cards.size,
      parked: free.length,
      start: layout.start,
      end: layout.end,
      limit: win.limit,
      cols: layout.cols,
      cardW: layout.cardW,
      cardH: layout.cardH,
      overscanScreens,
      lastWorkMs,
      workP95: p95,
      workSamples: workSamples.length,
    };
  }

  function destroy() {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = 0;
    if (ro) {
      try { ro.disconnect(); } catch (_) { /* ignore */ }
      ro = null;
    }
    wrap?.removeEventListener('scroll', onScroll);
    for (const el of cards.values()) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    for (const el of free) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    cards.clear();
    free.length = 0;
  }

  wrap?.addEventListener('scroll', onScroll, { passive: true });
  if (typeof ResizeObserver !== 'undefined' && wrap) {
    ro = new ResizeObserver(() => onResize());
    ro.observe(wrap);
  }

  return {
    sync,
    requestSync,
    measure,
    cardForPath,
    indexOfPath,
    itemAtIndex,
    indexFromPoint,
    scrollToPath,
    getScrollTop,
    setScrollTop,
    refreshPath,
    refreshAllVisible,
    invalidate,
    stats,
    destroy,
    get layout() { return layout; },
    get items() { return lastItems; },
  };
}

export { createVirtualGrid, OVERSCAN_SCREENS, GAP };
