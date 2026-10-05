// @ts-check
/**
 * Priority limiter: at most four concurrent upstream requests per page, served by priority 0 (alerts) to 3 (media and zone fallbacks) (blueprint 3.2).
 * Under contention the lowest priority number starts first; equal priorities start in arrival order. DOM-free.
 */
import { APP } from '../config/app.js';

/** @typedef {import('../types.js').Priority} Priority */
/** @typedef {{ run<T>(priority: Priority, task: () => Promise<T>, signal?: AbortSignal): Promise<T>, pending(): number }} Limiter */

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Error}
 */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A limiter instance; tests create their own. `pending()` counts tasks that are queued and have not started.
 * A task that is aborted while queued never starts and rejects with an AbortError; a running task is never
 * interrupted by the limiter (the task owns its own signal).
 * @param {{ maxConcurrent: number }} opts
 * @returns {Limiter}
 */
export function createLimiter(opts) {
  const max = Math.max(1, Math.floor(opts.maxConcurrent));
  /** @type {{ priority: number, seq: number, start: () => void, cancel: (e: Error) => void }[]} */
  const queue = [];
  let running = 0;
  let seq = 0;

  function pump() {
    while (running < max && queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i += 1) {
        const a = /** @type {{ priority: number, seq: number }} */ (queue[i]);
        const b = /** @type {{ priority: number, seq: number }} */ (queue[best]);
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const next = queue.splice(best, 1)[0];
      next?.start();
    }
  }

  return {
    run(priority, task, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError(signal)); return; }
        /** @type {(() => void) | null} */
        let onAbort = null;
        const entry = {
          priority,
          seq: seq++,
          start() {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            running += 1;
            Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(() => { running -= 1; pump(); });
          },
          /** @param {Error} e */
          cancel(e) { reject(e); },
        };
        if (signal) {
          onAbort = () => {
            const i = queue.indexOf(entry);
            if (i >= 0) { queue.splice(i, 1); entry.cancel(abortError(signal)); }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        queue.push(entry);
        pump();
      });
    },
    pending: () => queue.length,
  };
}

/** @type {Limiter | null} */
let shared = null;

/**
 * The page-wide limiter used by core/net.js.
 * @returns {Limiter}
 */
export function sharedLimiter() {
  shared ??= createLimiter({ maxConcurrent: APP.net.maxConcurrent });
  return shared;
}
