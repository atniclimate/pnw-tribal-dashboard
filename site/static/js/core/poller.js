// @ts-check
/**
 * Visibility-aware poller: pauses when hidden, refreshes immediately on return if older than the interval,
 * doubles the interval after each failure up to ten minutes, resumes on online (blueprint 3.13). DOM module.
 * The interval never drops below minMs.
 */

/** @typedef {import('../types.js').Poller} Poller */
/** @typedef {import('../types.js').PollerOptions} PollerOptions */

export const MAX_BACKOFF_MS = 600_000;

/** @returns {number} uniform in [0, 1) without Math.random (banned in site/) */
function unit() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return (c.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4_294_967_296;
  return 0.5;
}

/**
 * @param {PollerOptions} opts
 * @returns {Poller}
 */
export function createPoller(opts) {
  const base = Math.max(opts.minMs, opts.visibleMs);
  const jitter = opts.jitter ?? 0.1;
  let failures = 0;
  let started = false;
  let lastRunAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Promise<void> | null} */
  let inflight = null;

  const interval = () => Math.min(MAX_BACKOFF_MS, Math.max(opts.minMs, base * 2 ** failures));
  const hidden = () => Boolean(globalThis.document?.hidden);

  function clearTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  /** @param {number} delay */
  function schedule(delay) {
    clearTimer();
    if (!started || hidden()) return;
    const spread = 1 + (unit() * 2 - 1) * jitter;
    timer = setTimeout(() => { timer = null; void runNow(); }, Math.max(0, Math.round(delay * spread)));
  }

  /** @returns {Promise<void>} */
  function runNow() {
    if (inflight) return inflight;
    clearTimer();
    controller = new AbortController();
    const signal = controller.signal;
    lastRunAt = Date.now();
    inflight = (async () => {
      let ok = false;
      try { ok = await opts.run(signal); } catch { ok = false; }
      if (signal.aborted) return;
      failures = ok ? 0 : failures + 1;
    })().finally(() => {
      inflight = null;
      schedule(interval());
    });
    return inflight;
  }

  function onVisibility() {
    if (!started) return;
    if (hidden()) { clearTimer(); return; }
    const age = Date.now() - lastRunAt;
    if (age >= interval()) void runNow();
    else schedule(interval() - age);
  }

  function onOnline() {
    if (!started) return;
    failures = 0;
    void runNow();
  }

  return {
    start() {
      if (started) return;
      started = true;
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
      globalThis.addEventListener?.('online', onOnline);
      lastRunAt = Date.now();
      schedule(interval());
    },
    stop() {
      started = false;
      clearTimer();
      controller?.abort();
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('online', onOnline);
    },
    runNow,
    get intervalMs() { return interval(); },
  };
}
