// @ts-check
/** Register after load and show a device-cache notice without inventing a data timestamp. */
export function initOffline() {
  const banner = document.createElement('p');
  banner.className = 'callout callout--quiet';
  banner.setAttribute('role', 'status');
  banner.setAttribute('data-offline-banner', '');
  banner.hidden = true;
  document.querySelector('main')?.prepend(banner);
  let cached = false;
  const paint = () => {
    const offline = globalThis.navigator?.onLine === false;
    banner.hidden = !offline && !cached;
    banner.textContent = offline
      ? 'Offline. Showing information saved on this device where available. Check each panel for its source and last update. Current alert status is unknown.'
      : 'Some information was loaded from this device because an update failed. Check each panel for its source and last update.';
  };
  const online = () => { cached = false; paint(); };
  const message = (/** @type {MessageEvent} */ event) => {
    if (event.data?.type === 'cthd-cache' && typeof event.data.url === 'string' && event.data.url.includes('/data/live/')) { cached = true; paint(); }
  };
  globalThis.addEventListener('offline', paint);
  globalThis.addEventListener('online', online);
  globalThis.navigator?.serviceWorker?.addEventListener('message', message);
  const register = () => {
    void import('../core/sw-register.js').then(({ registerServiceWorker }) => {
      const home = document.querySelector('.site-header__brand')?.getAttribute('href') ?? './';
      return registerServiceWorker({ scriptUrl: new URL('sw.js', new URL(home, location.href)).href, onUpdate: (activate) => {
        const notice = document.createElement('p');
        notice.className = 'callout callout--quiet';
        notice.setAttribute('role', 'status');
        notice.setAttribute('data-update-notice', '');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Load updated site';
        button.addEventListener('click', () => { button.disabled = true; activate(); }, { once: true });
        notice.append('An updated version is ready. ', button);
        document.querySelector('[data-update-notice]')?.remove();
        document.querySelector('main')?.prepend(notice);
      } });
    }).catch(() => {});
  };
  if (document.readyState === 'complete') register();
  else globalThis.addEventListener('load', register, { once: true });
  paint();
  return () => {
    globalThis.removeEventListener('offline', paint);
    globalThis.removeEventListener('online', online);
    globalThis.removeEventListener('load', register);
    globalThis.navigator?.serviceWorker?.removeEventListener('message', message);
    banner.remove();
    document.querySelector('[data-update-notice]')?.remove();
  };
}
