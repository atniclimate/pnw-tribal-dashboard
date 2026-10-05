// @ts-check
/**
 * Polite live regions (blueprint 9.7): alert counts, banners, and filter result counts are announced only
 * when the message changes; no assertive regions exist. The page-wide region is created on first use as a
 * visually hidden element at the end of <body>. DOM module. Owner: lane L1.
 */

/**
 * @param {HTMLElement} el
 * @returns {{ announce(message: string): void }}
 */
export function createLiveRegion(el) {
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'status');
  el.classList.add('live-region');
  let last = el.textContent ?? '';
  return {
    announce(message) {
      const text = String(message ?? '').trim();
      if (text === last) return;
      last = text;
      el.textContent = text;
    },
  };
}

/** @type {{ announce(message: string): void } | null} */
let pageRegion = null;

/**
 * Page-wide polite region.
 * @param {string} message
 * @returns {void}
 */
export function announce(message) {
  if (!pageRegion) {
    const el = document.createElement('div');
    el.setAttribute('data-live-region', 'page');
    document.body.append(el);
    pageRegion = createLiveRegion(el);
  }
  pageRegion.announce(message);
}
