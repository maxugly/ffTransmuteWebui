/**
 * Custom vanilla DOM virtualizer for catalog cards.
 *
 * Scroll parent: .pool-grid-wrap
 * Canvas:        .pool-scroll-canvas
 * Cards:         direct-child .pool-card (absolute + translate3d)
 *
 * Visible window + 1.5 screen-heights of overscan. Identity is always the
 * canonical path — never a DOM index.
 */

const OVERSCAN_SCREENS = 1.5;
const GAP = 8;

function _colsFor(width, minCol) {
  const inner = Math.max(1, width);
  return Math.max(1, Math.floor((inner + GAP) / (minCol + GAP)));
}

function createVirtualGrid({
  wrap,
  canvas,
  getItems,
  renderCard,
  bindCard,
  minColWidth = 200,
  overscanScreens = OVERSCAN_SCREENS,
} = {}) {
  const cards = new Map(); // path → element
  const free = [];
  let layout = { cols: 1, cardW: minColWidth, cardH: minColWidth * 9 / 16, totalH: 0, start: 0, end: 0 };
  let raf = 0;
  let lastItems = [];
  let destroyed = false;
  let firstPaintMarked = false;
  let measureKey = '';
  let syncing = false;
  let ro = null;

  function measure() {
    if (!wrap || !canvas) return layout;
    const widthNow = wrap.clientWidth;
    const cssMin = parseFloat(getComputedStyle(canvas).getPropertyValue('--pool-tile-min')) || minColWidth;
    const key = `${Math.round(widthNow / 24) * 24}:${cssMin}`;
    if (key === measureKey && layout.cardW) return layout;
    measureKey = key;
    const padL = parseFloat(getComputedStyle(wrap).paddingLeft) || 0;
    const padR = parseFloat(getComputedStyle(wrap).paddingRight) || 0;
    const width = Math.max(1, widthNow - padL - padR);
    const minCol = Number(cssMin) || Number(minColWidth) || 200;
    const cols = _colsFor(width, minCol);
    const cardW = Math.max(40, (width - GAP * (cols - 1)) / cols);
    const cardH = Math.max(cardW * 9 / 16, 72);
    layout = { ...layout, cols, cardW, cardH, width };
    return layout;
  }

  function windowRange(itemCount) {
    const viewH = Math.max(1, Math.min(wrap.clientHeight || 1, (typeof window !== 'undefined' ? window.innerHeight : 1080) || 1080));
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
    if (typeof bindCard === 'function') bindCard(el);
    return el;
  }

  function acquireCard() {
    if (free.length) return free.pop();
    return createCard();
  }

  function releaseCard(el) {
    el.dataset.path = '';
    el.dataset.hash = '';
    el.dataset.idx = '';
    el.classList.remove('selected', 'hovered', 'seq-active', 'dragging', 'menu-open');
    if (el.parentNode) el.parentNode.removeChild(el);
    free.push(el);
  }

  function sync() {
    if (destroyed || !wrap || !canvas || syncing) return layout;
    syncing = true;
    try {
    return _syncBody();
    } finally {
      syncing = false;
    }
  }

  function _syncBody() {
    measure();
    const items = getItems() || [];
    lastItems = items;
    const n = items.length;
    const rows = n ? Math.ceil(n / layout.cols) : 0;
    layout.totalH = rows ? rows * layout.cardH + Math.max(0, rows - 1) * GAP : 0;
    canvas.style.height = `${layout.totalH}px`;
    canvas.style.position = 'relative';

    if (!n) {
      for (const [p, el] of cards) {
        releaseCard(el);
        cards.delete(p);
      }
      layout.start = 0;
      layout.end = 0;
      return layout;
    }

    const win = windowRange(n);
    layout.start = win.start;
    layout.end = win.end;
    const warm = Math.min(win.limit, 96);
    while (cards.size + free.length < warm) free.push(createCard());

    const keep = new Set();
    const CREATE_BUDGET = 6;
    let created = 0;
    let deferred = false;
    const order = [];
    for (let i = win.visStart; i < win.visEnd; i++) order.push(i);
    for (let i = win.start; i < win.end; i++) {
      if (i < win.visStart || i >= win.visEnd) order.push(i);
    }
    for (const i of order) {
      const item = items[i];
      if (!item || !item.path) continue;
      keep.add(item.path);
      let el = cards.get(item.path);
      if (!el) {
        if (created >= CREATE_BUDGET) {
          deferred = true;
          keep.delete(item.path);
          continue;
        }
        el = acquireCard();
        cards.set(item.path, el);
        canvas.appendChild(el);
        if (typeof renderCard === 'function') renderCard(el, item, i);
        created += 1;
      }
      el.dataset.idx = String(i);
      positionCard(el, i);
    }

    for (const [p, el] of cards) {
      if (!keep.has(p)) {
        releaseCard(el);
        cards.delete(p);
      }
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
      sync();
    });
  }

  function onScroll() {
    requestSync();
  }

  function onResize() {
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
    const x = clientX - rect.left + wrap.scrollLeft - (parseFloat(getComputedStyle(wrap).paddingLeft) || 0);
    const y = clientY - rect.top + wrap.scrollTop - (parseFloat(getComputedStyle(wrap).paddingTop) || 0);
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
    sync();
  }

  function getScrollTop() {
    return wrap ? wrap.scrollTop : 0;
  }

  function setScrollTop(v) {
    if (wrap) wrap.scrollTop = Number(v) || 0;
    sync();
  }

  function refreshPath(path) {
    const el = cards.get(path);
    if (!el) return;
    const idx = indexOfPath(path);
    const item = idx >= 0 ? lastItems[idx] : null;
    if (item && typeof renderCard === 'function') renderCard(el, item, idx);
  }

  function refreshAllVisible() {
    for (const [p, el] of cards) {
      const idx = indexOfPath(p);
      const item = idx >= 0 ? lastItems[idx] : null;
      if (item && typeof renderCard === 'function') renderCard(el, item, idx);
    }
  }

  function stats() {
    const n = lastItems.length;
    const win = n ? windowRange(n) : { start: 0, end: 0, limit: 0 };
    return {
      items: n,
      mounted: cards.size,
      start: layout.start,
      end: layout.end,
      limit: win.limit,
      cols: layout.cols,
      cardW: layout.cardW,
      cardH: layout.cardH,
      overscanScreens,
    };
  }

  function destroy() {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ro) {
      try { ro.disconnect(); } catch (_) { /* ignore */ }
      ro = null;
    }
    wrap?.removeEventListener('scroll', onScroll);
    for (const el of cards.values()) releaseCard(el);
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
    stats,
    destroy,
    get layout() { return layout; },
    get items() { return lastItems; },
  };
}

export { createVirtualGrid, OVERSCAN_SCREENS, GAP };
