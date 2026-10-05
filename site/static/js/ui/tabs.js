// @ts-check
/**
 * APG tabs (blueprint 7.3, 9.7) that enhance the static view links every page ships: without script, each
 * `.tabs__tab` is a link to `?view=<id>` and every view section stays visible; with script, the links
 * become a tablist with automatic activation (Left and Right arrows, Home, End), a roving tab stop, and
 * one visible `[data-view]` section at a time. On phones the strip scrolls inside itself as a segmented
 * control, and the selected tab is scrolled into view. The URL is the page's to update: onChange
 * receives the view id. DOM module. Owner: lane L1.
 */

/**
 * @param {HTMLElement} root the `.tabs` element holding `.tabs__tab` links or buttons with data-view-link
 * @param {{ onChange?: (id: string) => void }} [opts]
 * @returns {{ select(id: string): void, destroy(): void }}
 */
export function initTabs(root, opts = {}) {
  const tabs = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-view-link]')]);
  const scope = root.closest('main') ?? document;
  /** @param {string} id */
  const panelFor = (id) => /** @type {HTMLElement | null} */ (scope.querySelector(`[data-view="${CSS.escape(id)}"]`));
  const ids = tabs.map((t) => t.dataset.viewLink ?? '');

  root.setAttribute('role', 'tablist');
  if (!root.hasAttribute('aria-label')) root.setAttribute('aria-label', 'Views');
  tabs.forEach((tab, i) => {
    const id = /** @type {string} */ (ids[i]);
    if (!tab.id) tab.id = `tab-${id}`;
    tab.setAttribute('role', 'tab');
    const panel = panelFor(id);
    if (panel) {
      if (!panel.id) panel.id = `view-${id}`;
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.removeAttribute('aria-label');
    }
  });

  let current = '';
  /**
   * @param {string} id
   * @param {{ focus?: boolean, notify?: boolean }} [how]
   */
  function activate(id, how = {}) {
    const index = ids.indexOf(id);
    if (index < 0) return;
    const changed = id !== current;
    current = id;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (tab.getAttribute('aria-current')) tab.removeAttribute('aria-current');
      const panel = panelFor(/** @type {string} */ (ids[i]));
      if (panel) panel.hidden = !on;
    });
    const tab = /** @type {HTMLElement} */ (tabs[index]);
    if (how.focus) tab.focus();
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    if (changed && how.notify !== false) opts.onChange?.(id);
  }

  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const tab = /** @type {HTMLElement | null} */ ((/** @type {Element} */ (e.target)).closest('[data-view-link]'));
    if (!tab || !root.contains(tab)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // new-tab gestures keep the link
    e.preventDefault();
    activate(tab.dataset.viewLink ?? '');
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const i = ids.indexOf(current);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); return; }
    if (next < 0) return;
    e.preventDefault();
    activate(/** @type {string} */ (ids[next]), { focus: true });
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);

  const fromUrl = new URL(location.href).searchParams.get('view');
  const marked = tabs.find((t) => t.getAttribute('aria-current') === 'page' || t.getAttribute('aria-selected') === 'true');
  activate(fromUrl && ids.includes(fromUrl) ? fromUrl : (marked?.dataset.viewLink ?? ids[0] ?? ''), { notify: false });

  return {
    select(id) { activate(id); },
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.removeAttribute('role');
      tabs.forEach((tab, i) => {
        tab.removeAttribute('role');
        tab.removeAttribute('aria-selected');
        tab.removeAttribute('tabindex');
        const panel = panelFor(/** @type {string} */ (ids[i]));
        if (panel) { panel.hidden = false; panel.removeAttribute('role'); }
      });
    },
  };
}
