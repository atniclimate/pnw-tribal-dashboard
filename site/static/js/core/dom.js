// @ts-check
/**
 * Escaping by construction (blueprint 3.4). Data reaches the DOM only through h() or textContent:
 * strings become Text nodes, on* attributes are rejected, and URL attributes pass through safeUrl or are
 * dropped. There is no HTML-string path. DOM module.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'title', 'desc']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'xlink:href']);
const TAG = /^[a-z][a-z0-9-]*$/i;
const ATTR = /^[a-z_:][a-z0-9_:.-]*$/i;
const DEFAULT_SCHEMES = ['https:', 'http:', 'tel:', 'mailto:'];

/**
 * '' when the scheme is not allowed (javascript:, data:, and vbscript: never pass). Relative references
 * (no scheme) pass. Whitespace and control characters browsers ignore inside a scheme are stripped before
 * the check, so "java\tscript:" is blocked too.
 * @param {string} u
 * @param {string[]} [allow] default ['https:', 'http:', 'tel:', 'mailto:']
 * @returns {string}
 */
export function safeUrl(u, allow = DEFAULT_SCHEMES) {
  if (typeof u !== 'string') return '';
  const trimmed = u.trim();
  const probe = Array.from(trimmed).filter((c) => !ignorable(c.codePointAt(0) ?? 0)).join('');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!m) return trimmed;
  return allow.includes(`${(m[1] ?? '').toLowerCase()}:`) ? trimmed : '';
}

/**
 * Control characters and spaces that browsers ignore inside a URL scheme.
 * @param {number} n code point
 * @returns {boolean}
 */
function ignorable(n) {
  return n <= 0x20 || n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200b)
    || n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f || n === 0x3000 || n === 0xfeff;
}

/**
 * 'tel:+18002585990'. Accepts E.164 or a short code (211, 311, 511, 911, 988); ten-digit and eleven-digit
 * North American numbers are normalized. '' when the input is not a dialable number.
 * @param {string} e164
 * @returns {string}
 */
export function telHref(e164) {
  const digits = String(e164).replace(/[\s().-]/g, '');
  if (/^(211|311|511|911|988)$/.test(digits)) return `tel:${digits}`;
  if (/^\+[1-9][0-9]{6,14}$/.test(digits)) return `tel:${digits}`;
  if (/^[2-9][0-9]{9}$/.test(digits)) return `tel:+1${digits}`;
  if (/^1[2-9][0-9]{9}$/.test(digits)) return `tel:+${digits}`;
  return '';
}

/**
 * Element builder. Throws on an on* attribute (a programming error, never data), on a script element, and
 * on srcdoc. Drops null, undefined, and false attributes; style attributes are dropped (CSP forbids inline
 * styles; use classes). `dataset` takes an object. svg and its drawing children are created in the SVG namespace.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children strings and numbers become Text nodes; arrays are flattened; null, undefined, false are skipped
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  if (!TAG.test(tag)) throw new Error(`h(): invalid tag "${tag}"`);
  const name = tag.toLowerCase();
  if (name === 'script') throw new Error('h(): script elements are not allowed');
  const el = /** @type {HTMLElement} */ (SVG_TAGS.has(name) ? document.createElementNS(SVG_NS, name) : document.createElement(name));
  for (const [rawKey, value] of Object.entries(attrs ?? {})) {
    const key = rawKey.toLowerCase();
    if (key.startsWith('on')) throw new Error(`h(): event handler attribute "${rawKey}" is not allowed; use on() from core/dom.js`);
    if (key === 'srcdoc') throw new Error('h(): srcdoc is not allowed');
    if (value === null || value === undefined || value === false) continue;
    if (key === 'style') continue;
    if (key === 'dataset' && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        if (dv !== null && dv !== undefined && dv !== false) el.dataset[dk] = String(dv);
      }
      continue;
    }
    if (!ATTR.test(rawKey)) continue;
    if (URL_ATTRS.has(key)) {
      const safe = safeUrl(String(value));
      if (safe !== '') el.setAttribute(rawKey, safe);
      continue;
    }
    el.setAttribute(key === 'classname' ? 'class' : rawKey, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/**
 * @param {Element} el
 * @param {unknown[]} children
 */
function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { append(el, child); continue; }
    if (typeof child === 'string' || typeof child === 'number') { el.appendChild(document.createTextNode(String(child))); continue; }
    el.appendChild(/** @type {Node} */ (child));
  }
}

/**
 * Removes every child.
 * @param {Element} el
 * @returns {void}
 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Event delegation on data-action attributes; returns an unsubscribe function.
 * @param {Element} root
 * @param {string} action value of a data-action attribute
 * @param {(event: Event, target: HTMLElement) => void} handler
 * @param {string} [type] event type, default 'click'
 * @returns {() => void}
 */
export function on(root, action, handler, type = 'click') {
  /** @param {Event} event */
  const listener = (event) => {
    const start = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
    const target = /** @type {HTMLElement | null} */ (start?.closest('[data-action]') ?? null);
    if (target && root.contains(target) && target.getAttribute('data-action') === action) handler(event, target);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}
