// @ts-check
/**
 * Phone bottom bar: Alerts, Rivers, Call, Near Me under the thumb (blueprint 7.0, 9.7). The bar is static
 * links in every page's chrome, so it works without script; this module marks the item for the current
 * page and view with aria-current and, when the page supplies onCall, opens the Call sheet in place
 * instead of navigating to Contacts. Hidden in embed mode and at 720 px and wider by layout.css.
 * DOM module. Owner: lane L1.
 */

/**
 * Which bar item matches a URL. Pure; exported for tests.
 * @param {string} href an item's resolved href
 * @param {string} current the page's URL
 * @returns {boolean}
 */
export function itemMatches(href, current) {
  const a = new URL(href, current);
  const c = new URL(current);
  if (a.origin !== c.origin || a.pathname !== c.pathname) return false;
  const want = a.searchParams.get('view');
  const have = c.searchParams.get('view');
  return want === have || (want === null && (have === null || have === ''));
}

/**
 * @param {{ onCall?: () => void }} [opts]
 * @returns {() => void}
 */
export function initBottomBar(opts = {}) {
  const bar = document.querySelector('.bottom-bar');
  if (!bar) return () => {};
  const items = /** @type {HTMLAnchorElement[]} */ ([...bar.querySelectorAll('a.bottom-bar__item')]);
  for (const a of items) {
    if (itemMatches(a.href, location.href)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const call = /** @type {HTMLAnchorElement | undefined} */ (items.find((a) => a.dataset.action === 'open-call-sheet'));
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    if (!opts.onCall || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    opts.onCall();
  };
  if (call && opts.onCall) {
    call.setAttribute('aria-haspopup', 'dialog');
    call.addEventListener('click', onClick);
  }
  return () => {
    if (call) { call.removeEventListener('click', onClick); call.removeAttribute('aria-haspopup'); }
  };
}
