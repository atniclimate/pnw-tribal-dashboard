// @ts-check
/**
 * Toast notices: short confirmations ("Copied", "Location unavailable") in a polite region above the phone
 * bottom bar. Never used for alerts, which live in the banner and panels. Each toast has a Close button;
 * it dismisses itself after timeoutMs (default 6000; 0 keeps it until closed), and the timer pauses while
 * the pointer or focus is on it. Motion follows the duration tokens, which are zero under reduced motion.
 * DOM module. Owner: lane L1.
 */

export const DEFAULT_TOAST_MS = 6000;

/** @returns {HTMLElement} */
function region() {
  let r = /** @type {HTMLElement | null} */ (document.querySelector('.toast-region'));
  if (!r) {
    r = document.createElement('div');
    r.className = 'toast-region';
    r.setAttribute('role', 'status');
    r.setAttribute('aria-live', 'polite');
    document.body.append(r);
  }
  return r;
}

/**
 * @param {string} message
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {() => void} dismiss
 */
export function showToast(message, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOAST_MS;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const text = document.createElement('p');
  text.className = 'toast__message';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Close Notice');
  close.textContent = '×';
  toast.append(text, close);
  region().append(toast);

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    toast.remove();
  };
  const arm = () => { if (timeoutMs > 0 && !done) timer = setTimeout(dismiss, timeoutMs); };
  const pause = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  close.addEventListener('click', dismiss);
  toast.addEventListener('pointerenter', pause);
  toast.addEventListener('pointerleave', arm);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', arm);
  arm();
  return dismiss;
}
