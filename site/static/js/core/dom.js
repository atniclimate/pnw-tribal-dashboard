// @ts-check
/**
 * Escaping by construction (blueprint 3.4). Data reaches the DOM only through h() or textContent. DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * Element builder.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs] on* attributes are rejected; href, src, and action pass through safeUrl or are dropped
 * @param {...(Node | string | number | null | undefined | false)} children strings become Text nodes
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * '' when the scheme is not allowed (javascript:, data:, and vbscript: never pass).
 * @param {string} u
 * @param {string[]} [allow] default ['https:', 'http:', 'tel:', 'mailto:']
 * @returns {string}
 */
export function safeUrl(u, allow) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * 'tel:+18002585990'.
 * @param {string} e164 E.164 number or a short code 211, 311, 511, 911, 988
 * @returns {string}
 */
export function telHref(e164) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Removes every child.
 * @param {Element} el
 * @returns {void}
 */
export function clear(el) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Event delegation on data-action attributes; returns an unsubscribe function.
 * @param {Element} root
 * @param {string} action value of a data-action attribute
 * @param {(event: Event, target: HTMLElement) => void} handler
 * @returns {() => void}
 */
export function on(root, action, handler) {
  throw new Error(NOT_IMPLEMENTED);
}
