// @ts-check
/**
 * Tiny store with change detection; inputs are never re-rendered (blueprint 3.13). DOM-free.
 * A set that changes nothing notifies nobody, so a typing field is not rebuilt by an unrelated update.
 */

/**
 * @template {object} T
 * @param {T} initial
 * @returns {import('../types.js').Store<T>}
 */
export function createStore(initial) {
  let state = { ...initial };
  /** @type {Set<(state: T, prev: T) => void>} */
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const keys = /** @type {(keyof T)[]} */ (Object.keys(patch));
      if (!keys.some((k) => !Object.is(state[k], patch[k]))) return;
      const prev = state;
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
