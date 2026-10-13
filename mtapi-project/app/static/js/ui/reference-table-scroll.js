/* Shared floating table chrome; the workspace keeps natural vertical height. */
export function bindReferenceTableScroll(scroller, { initialLeft = 0, onScroll = () => {} } = {}) {
  const table = scroller.querySelector('table');
  if (!table) return () => {};
  const owner = scroller.closest('.action-panel-form');
  const anchor = document.createElement('div');
  anchor.className = 'ref-floating-head';
  anchor.setAttribute('aria-hidden', 'true');
  const viewport = document.createElement('div');
  viewport.className = 'ref-floating-head-viewport';
  anchor.append(viewport);
  scroller.before(anchor);
  const rail = document.createElement('div');
  rail.className = 'ref-bottom-scroll amr-horizontal-scroll';
  rail.tabIndex = 0;
  rail.setAttribute('role', 'region');
  rail.setAttribute('aria-label', 'Horizontal table scroll');
  rail.dataset.helpTitle = 'Horizontal table scroll';
  rail.dataset.helpText = 'This strip stays underneath the table at the bottom of the workspace. Drag it or use Left/Right arrow keys.';
  rail.append(document.createElement('div'));
  scroller.after(rail);
  let disposed = false;
  const updatePosition = () => {
    if (!scroller.isConnected) { dispose(); return; }
    const top = owner.getBoundingClientRect().top;
    const head = table.tHead;
    const visible = head && head.getBoundingClientRect().top < top && table.getBoundingClientRect().bottom > top + head.offsetHeight;
    anchor.classList.toggle('is-pinned', Boolean(visible));
    anchor.setAttribute('aria-hidden', String(!visible));
    if (visible) viewport.scrollLeft = scroller.scrollLeft;
  };
  const resize = () => {
    if (!scroller.isConnected) { dispose(); return; }
    rail.firstElementChild.style.width = `${scroller.scrollWidth}px`;
    rail.hidden = scroller.scrollWidth <= scroller.clientWidth + 1;
    if (table.tHead) {
      const clone = table.cloneNode(false);
      clone.removeAttribute('id');
      clone.removeAttribute('data-mtable');
      clone.removeAttribute('data-ytable');
      clone.style.width = `${table.getBoundingClientRect().width}px`;
      clone.style.tableLayout = 'fixed';
      const head = table.tHead.cloneNode(true);
      head.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      const originals = [...table.tHead.querySelectorAll('th')];
      head.querySelectorAll('th').forEach((cell, i) => {
        const width = originals[i].getBoundingClientRect().width;
        cell.style.width = `${width}px`;
        cell.style.minWidth = `${width}px`;
        cell.style.maxWidth = `${width}px`;
        cell.addEventListener('click', event => {
          const input = event.target.closest('input');
          if (input) {
            const original = originals[i].querySelector('input');
            original.checked = input.checked;
            original.dispatchEvent(new Event('change', {bubbles: true}));
          } else originals[i].click();
        });
      });
      clone.append(head);
      viewport.replaceChildren(clone);
    }
    viewport.scrollLeft = rail.scrollLeft = scroller.scrollLeft;
    updatePosition();
  };
  const sync = source => {
    const left = source.scrollLeft;
    if (Math.abs(scroller.scrollLeft - left) > 1) scroller.scrollLeft = left;
    if (Math.abs(rail.scrollLeft - left) > 1) rail.scrollLeft = left;
    viewport.scrollLeft = left;
    onScroll(left);
  };
  const tableScroll = () => sync(scroller);
  const railScroll = () => sync(rail);
  const resizeObserver = new ResizeObserver(resize);
  const mutationObserver = new MutationObserver(resize);
  function dispose() {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect(); mutationObserver.disconnect();
    owner.removeEventListener('scroll', updatePosition);
    scroller.removeEventListener('scroll', tableScroll);
    rail.removeEventListener('scroll', railScroll);
    anchor.remove(); rail.remove();
  }
  scroller.addEventListener('scroll', tableScroll);
  rail.addEventListener('scroll', railScroll);
  owner.addEventListener('scroll', updatePosition, {passive: true});
  resizeObserver.observe(scroller); resizeObserver.observe(table);
  mutationObserver.observe(table, {subtree: true, childList: true, attributes: true});
  // Dispose even when switching tabs without another scroll/resize event.
  mutationObserver.observe(owner, {childList: true});
  scroller.scrollLeft = Number(initialLeft) || 0;
  resize();
  return dispose;
}
