// @ts-check
/**
 * Chrome behavior (blueprint 7.0): the current navigation item, the Nation chip label, the footer's list
 * of sources used on the page, and the deploy time. The chrome itself is static HTML in every page, so
 * navigation works with script off; this module only refines it. Data never reaches the DOM except as
 * text. It imports nothing, so it adds no module to any page's preload list. DOM module. Owner: lane L1.
 */

/** @typedef {import('../types.js').PageId} PageId */

/**
 * Registry source ids named by the page's panels (`[data-panel][data-sources]`), in first-seen order.
 * @param {ParentNode} root
 * @returns {string[]}
 */
export function pageSourceIds(root) {
  /** @type {string[]} */
  const ids = [];
  for (const el of root.querySelectorAll('[data-panel][data-sources]')) {
    for (const id of (el.getAttribute('data-sources') ?? '').split(/\s+/)) if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Sets the Nation chip's visible name (text only). Pages call it after a Nation is chosen.
 * @param {string | null} name the Nation's display name, or null for all of Cascadia
 * @returns {void}
 */
export function setNationChip(name) {
  for (const el of document.querySelectorAll('[data-nation-chip-name]')) el.textContent = name && name.trim() ? name : 'All of Cascadia';
}

/**
 * @param {{ page: PageId, sources?: Readonly<Record<string, string>>, builtAt?: string | null }} opts
 *   sources: registry id to display name, to list the page's sources in the footer (each links to its entry
 *   on the Usage page); builtAt: a preformatted deploy time, shown as "Updated <builtAt>".
 * @returns {() => void}
 */
export function initChrome(opts) {
  void opts.page;

  // Current navigation item: the static chrome marks it already; keep it true after client-side changes.
  for (const a of document.querySelectorAll('.site-nav__list a')) {
    const link = /** @type {HTMLAnchorElement} */ (a);
    const same = new URL(link.href).pathname === location.pathname;
    if (same) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  // Sources used on this page, by name, when the page has resolved them from the registry.
  const slot = document.querySelector('[data-footer-sources]');
  const names = opts.sources ?? null;
  if (slot && names) {
    const ids = pageSourceIds(document).filter((id) => names[id]);
    if (ids.length) {
      // The footer's first link is the Usage page, written relative to this page by the static chrome.
      const usage = new URL(document.querySelector('.site-footer__links a')?.getAttribute('href') ?? '../usage/', location.href);
      const items = ids.map((id) => {
        const a = document.createElement('a');
        const u = new URL(usage.href);
        u.searchParams.set('view', 'sources');
        u.hash = `src-${id}`;
        a.href = u.toString();
        a.textContent = /** @type {string} */ (names[id]);
        return a;
      });
      const parts = /** @type {(Node | string)[]} */ ([]);
      items.forEach((a, i) => {
        if (i > 0) parts.push(i === items.length - 1 ? (items.length > 2 ? ', and ' : ' and ') : ', ');
        parts.push(a);
      });
      slot.replaceChildren(...parts);
    }
  }

  const build = /** @type {HTMLElement | null} */ (document.querySelector('[data-build-info]'));
  if (build && opts.builtAt) {
    build.textContent = `Updated ${opts.builtAt}`;
    build.hidden = false;
  }

  return () => {};
}
