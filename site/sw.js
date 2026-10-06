// @ts-check
/* eslint-disable no-restricted-globals -- The same-origin service worker owns its network and cache transport. */
/** Small, bounded offline cache. Observation timestamps are never rewritten. */
const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (globalThis));
const BUILD = 'development'; // CTHD_BUILD
const PRECACHE = /** @type {string[]} */ ([]); // CTHD_PRECACHE
const BASE = new URL('./', worker.location.href);
const SHELL = `cthd-shell-${BUILD}`;
const DATA = 'cthd-data';
/** @type {Record<string, number>} */
const LIMITS = { [SHELL]: 8 * 1024 * 1024, [DATA]: 17 * 1024 * 1024 };
let disabled = false;
let writes = Promise.resolve();

/** @param {string} name @param {Request | string} request @param {Response} response */
function save(name, request, response) {
  if (!response.ok || response.status !== 200 || response.type === 'opaque') return Promise.resolve();
  const target = new URL(typeof request === 'string' ? request : request.url, BASE);
  const final = new URL(response.url || target.href, BASE);
  if (target.origin !== BASE.origin || final.origin !== BASE.origin || !final.pathname.startsWith(BASE.pathname)
      || /(?:^|,)\s*no-store\b/i.test(response.headers.get('Cache-Control') ?? '')) return Promise.resolve();
  const copy = response.clone();
  writes = writes.then(async () => {
    if (disabled) return;
    const bytes = await copy.arrayBuffer();
    const limit = LIMITS[name] ?? 0;
    if (bytes.byteLength > limit) return;
    const headers = new Headers(copy.headers);
    headers.set('X-CTHD-Bytes', String(bytes.byteLength));
    headers.set('X-CTHD-Saved', new Date().toISOString());
    // Fetch exposes decoded bytes; encoding/length from the wire no longer apply.
    headers.delete('content-encoding');
    headers.delete('content-length');
    const cache = await caches.open(name);
    await cache.delete(request);
    await cache.put(request, new Response(bytes, { status: copy.status, statusText: copy.statusText, headers }));
    const keys = await cache.keys();
    let total = 0;
    const sizes = await Promise.all(keys.map(async (key) => Number((await cache.match(key))?.headers.get('X-CTHD-Bytes') ?? 0)));
    for (const size of sizes) total += size;
    for (let i = 0; total > limit && i < keys.length; i++) {
      const key = keys[i];
      if (key) await cache.delete(key);
      total -= sizes[i] ?? 0;
    }
  }).catch(() => { /* Storage denial or quota exhaustion must not break a page. */ });
  return writes;
}

/** @param {string} name @param {Request | string} request */
async function saved(name, request) {
  try {
    const cache = await caches.open(name);
    const response = await cache.match(request);
    if (!response) return null;
    // Cache insertion order is the LRU order, without changing the saved timestamp.
    writes = writes.then(async () => {
      if (disabled) return;
      const current = await cache.match(request);
      if (!current) return;
      await cache.delete(request);
      await cache.put(request, current);
    }).catch(() => {});
    await writes;
    return response;
  } catch { return null; }
}

/** @param {Request | string} request @param {number} timeoutMs */
async function network(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request, { signal: controller.signal, cache: 'no-cache' });
    // Finish reading inside the timeout, while retaining the real final URL and
    // response type so redirected or opaque responses cannot enter our cache.
    await response.clone().arrayBuffer();
    return response;
  }
  finally { clearTimeout(timer); }
}

async function stop() {
  disabled = true;
  await writes;
  await Promise.all((await caches.keys()).filter((name) => name.startsWith('cthd-')).map((name) => caches.delete(name)));
  await worker.registration.unregister();
}

async function checkKillSwitch() {
  try {
    const response = await network(new URL('build-info.json', BASE).href, 4000);
    if (response.ok && (await response.json()).swDisabled === true) await stop();
  } catch { /* An offline device keeps its previously saved pages. */ }
}

/** @param {Response} response @param {string} url @param {string} clientId */
async function fallback(response, url, clientId) {
  const headers = new Headers(response.headers);
  headers.set('X-CTHD-Cache', 'cached');
  let asOf = null;
  if (headers.get('Content-Type')?.includes('json')) {
    try {
      const body = await response.clone().json();
      if (typeof body?.asOf === 'string' && Number.isFinite(Date.parse(body.asOf))) asOf = body.asOf;
    } catch { /* Cache transport does not repair or invent an observation time. */ }
  }
  try {
    const client = clientId ? await worker.clients.get(clientId) : null;
    client?.postMessage({ type: 'cthd-cache', url, asOf, savedAt: headers.get('X-CTHD-Saved') });
  } catch { /* The requesting tab may have closed. */ }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** @param {string} name @param {Request | string} key @param {Response} response */
async function removeDeleted(name, key, response) {
  if (response.status !== 404 && response.status !== 410) return;
  writes = writes.then(async () => { await (await caches.open(name)).delete(key); }).catch(() => {});
  await writes;
}

/** @param {Request} request @param {string} name @param {number} timeoutMs @param {string} clientId @param {boolean} navigation */
async function networkFirst(request, name, timeoutMs, clientId, navigation = false) {
  const key = navigation ? new URL(new URL(request.url).pathname, BASE).href : request;
  try {
    const response = await network(request, timeoutMs);
    if (response.ok) { await save(name, key, response); return response; }
    // Missing/deleted content must not be resurrected from a device copy.
    if (response.status < 500) { await removeDeleted(name, key, response); return response; }
  } catch { /* Network failure: consult only this application's cache. */ }
  const copy = await saved(name, key) ?? (navigation ? await saved(SHELL, new URL('offline.html', BASE).href) : null);
  return copy ? fallback(copy, request.url, clientId) : new Response('No saved information is available.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

worker.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (new URL(worker.location.href).searchParams.get('precache') === '0') return;
    // Sequential requests keep post-load downloads from saturating a phone's radio.
    for (const relative of PRECACHE) {
      if (disabled) break;
      const url = new URL(relative, BASE);
      if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || /\/(?:map|vendor)\//.test(url.pathname)) continue;
      try {
        const response = await network(url.href, 5000);
        await save(relative.startsWith('data/') ? DATA : SHELL, url.href, response);
      } catch { /* Partial offline preparation is preferable to a failed install. */ }
    }
  })());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await checkKillSwitch();
    if (disabled) return;
    await Promise.all((await caches.keys()).filter((name) => name.startsWith('cthd-') && name !== SHELL && name !== DATA).map((name) => caches.delete(name)));
    await worker.clients.claim();
  })());
});

// Activation of an update is an explicit page control, never an install-time surprise.
worker.addEventListener('message', (event) => {
  if (event.data?.type !== 'cthd-activate' || !event.source || !('url' in event.source)) return;
  const source = new URL(event.source.url);
  if (source.origin === BASE.origin && source.pathname.startsWith(BASE.pathname)) event.waitUntil(worker.skipWaiting());
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (disabled || request.method !== 'GET' || request.headers.has('Range') || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (relative === 'sw.js' || relative === 'build-info.json') return;
  if (request.mode === 'navigate') {
    event.waitUntil(checkKillSwitch());
    // A new navigation client is not execution-ready until this response arrives.
    // Awaiting clients.get(resultingClientId) while producing it can deadlock.
    event.respondWith(networkFirst(request, SHELL, 4000, '', true));
  } else if (/^v\/[a-f0-9]{12}\//.test(relative)) {
    event.respondWith((async () => {
      const copy = await saved(SHELL, request);
      if (copy) return copy;
      const response = await fetch(request);
      await save(SHELL, request, response);
      return response;
    })());
  } else if (relative.startsWith('data/live/')) {
    event.respondWith(networkFirst(request, DATA, 5000, event.clientId));
  } else if (/^data\/(?:curated|registry|ref|geo)\//.test(relative)) {
    const update = network(request, 5000).then(async (response) => {
      await removeDeleted(DATA, request, response);
      await save(DATA, request, response);
      return response;
    });
    event.waitUntil(update.then(() => {}, () => {}));
    event.respondWith((async () => {
      const copy = await saved(DATA, request);
      if (copy) return fallback(copy, request.url, event.clientId);
      try { return await update; } catch { return new Response('No saved information is available.', { status: 503 }); }
    })());
  }
});
