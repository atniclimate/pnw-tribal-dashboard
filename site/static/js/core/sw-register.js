// @ts-check
/**
 * Registers site/sw.js only in top-level contexts on https (blueprint 8.4); L9 owns the worker. DOM module.
 * Never registers inside an iframe; honors build-info.json swDisabled by unregistering any worker instead.
 */
import { APP } from '../config/app.js';
import { fetchLocal } from './net.js';
import { SITE_BASE_PATH } from '../config/pages.js';

/**
 * @param {{ scriptUrl: string, onUpdate?: (activate: () => void) => void }} opts
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
    if (info.ok && info.data !== null && typeof info.data === 'object' && 'swDisabled' in info.data && info.data.swDisabled === true) {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.filter((r) => new URL(r.scope).pathname === SITE_BASE_PATH).map((r) => r.unregister()));
      if (globalThis.caches) await Promise.all((await caches.keys()).filter((name) => name.startsWith('cthd-')).map((name) => caches.delete(name)));
      return false;
    }
    const saveData = /** @type {{ connection?: { saveData?: boolean } }} */ (globalThis.navigator).connection?.saveData === true;
    const script = new URL(opts.scriptUrl, w.location.href);
    if (script.origin !== w.location.origin || script.pathname !== `${SITE_BASE_PATH}sw.js`) return false;
    if (saveData) script.searchParams.set('precache', '0');
    const registration = await sw.register(script.href, { scope: SITE_BASE_PATH, updateViaCache: 'none' });
    /** @type {ServiceWorker | null} */
    let offered = null;
    const offerUpdate = () => {
      const waiting = registration.waiting;
      if (!waiting || !sw.controller || waiting === offered || !opts.onUpdate) return;
      offered = waiting;
      let requested = false;
      opts.onUpdate(() => {
        if (requested || waiting.state === 'redundant') return;
        requested = true;
        // Only the tab whose user requested activation reloads. Other open pages keep
        // their versioned module graph and can finish using the retained generation.
        sw.addEventListener('controllerchange', () => w.location.reload(), { once: true });
        waiting.postMessage({ type: 'cthd-activate' });
      });
    };
    const watchInstalling = () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => { if (installing.state === 'installed') offerUpdate(); });
    };
    registration.addEventListener('updatefound', watchInstalling);
    watchInstalling();
    offerUpdate();
    return true;
  } catch {
    return false;
  }
}
