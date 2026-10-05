// @ts-check
/**
 * Registers site/sw.js only in top-level contexts on https (blueprint 8.4); L9 owns the worker. DOM module.
 * Never registers inside an iframe; honors build-info.json swDisabled by unregistering any worker instead.
 */
import { APP } from '../config/app.js';
import { fetchLocal } from './net.js';

/**
 * @param {{ scriptUrl: string }} opts
 * @returns {Promise<boolean>} true when a worker is registered
 */
export async function registerServiceWorker(opts) {
  try {
    if (!APP.flags.serviceWorker) return false;
    const w = globalThis;
    if (w.top !== w.self) return false;
    if (w.location?.protocol !== 'https:') return false;
    const sw = globalThis.navigator?.serviceWorker;
    if (!sw) return false;

    // Kill switch. If the marker cannot be read (offline, 404 in development), registering is still safe:
    // the worker reads the same marker itself.
    const info = await fetchLocal('build-info.json', { retries: 0, timeoutMs: 5000 });
    if (info.ok && /** @type {any} */ (info.data)?.swDisabled === true) {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      return false;
    }
    await sw.register(opts.scriptUrl);
    return true;
  } catch {
    return false;
  }
}
