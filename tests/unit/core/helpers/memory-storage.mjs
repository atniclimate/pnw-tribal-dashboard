// @ts-check
/** A Storage stand-in for unit tests, with an optional quota and a block switch. */
export class MemoryStorage {
  /** @param {{ quota?: number }} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, string>} */
    this.map = new Map();
    this.quota = opts.quota ?? Infinity;
    this.blocked = false;
  }

  get length() { return this.map.size; }

  /** @param {number} i */
  key(i) { return [...this.map.keys()][i] ?? null; }

  /** @param {string} k */
  getItem(k) { if (this.blocked) throw new Error('SecurityError'); return this.map.get(k) ?? null; }

  /** @param {string} k @param {string} v */
  setItem(k, v) {
    if (this.blocked) throw new Error('SecurityError');
    const used = [...this.map].reduce((n, [kk, vv]) => n + (kk === k ? 0 : kk.length + vv.length), 0);
    if (used + k.length + v.length > this.quota) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }

  /** @param {string} k */
  removeItem(k) { if (this.blocked) throw new Error('SecurityError'); this.map.delete(k); }
}
