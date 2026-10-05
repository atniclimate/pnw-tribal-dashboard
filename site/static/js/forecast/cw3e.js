// @ts-check
/**
 * CW3E IVT and IWV cycle resolution (blueprint 5.9, 7.3). Heavy: dynamic import() only. DOM-free.
 * CW3E retired every "current" image address, so the newest cycle is found by the ar-products snapshot task,
 * with an in-browser probe that steps back six hours when that manifest is stale.
 */

const SIX_HOURS_MS = 6 * 3_600_000;
const SEGMENT = /^[A-Za-z0-9_-]{1,40}$/;
/** A manifest cycle older than this is stale (cycles publish two to seven hours after their time, every six hours). */
export const STALE_AFTER_MS = 30 * 3_600_000;
/** Forecast hours shown: F000 to F168 in 12-hour steps. */
export const FORECAST_HOURS = Object.freeze(Array.from({ length: 15 }, (_, i) => i * 12));
/** How many six-hour cycles the browser probe tries (two days). */
export const PROBE_STEPS = 8;

/**
 * @param {string} template registry urlTemplate for cw3e-images
 * @param {{ product: string, model: string, domain: string, cycle: string, fh: number }} parts
 * @returns {string}
 */
export function cw3eUrl(template, parts) {
  for (const k of /** @type {const} */ (['product', 'model', 'domain'])) {
    if (!SEGMENT.test(parts[k])) throw new Error(`Invalid CW3E ${k} "${parts[k]}"`);
  }
  if (!/^\d{10}$/.test(parts.cycle)) throw new Error(`Invalid CW3E cycle "${parts.cycle}"`);
  if (!Number.isInteger(parts.fh) || parts.fh < 0 || parts.fh > 999) throw new Error(`Invalid forecast hour ${parts.fh}`);
  return template
    .replaceAll('{product}', parts.product)
    .replaceAll('{model}', parts.model)
    .replaceAll('{domain}', parts.domain)
    .replaceAll('{YYYYMMDDHH}', parts.cycle)
    .replaceAll('{hhh}', String(parts.fh).padStart(3, '0'));
}

/**
 * @param {string} cycle YYYYMMDDHH (UTC)
 * @returns {Date}
 */
export function cycleDate(cycle) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(cycle);
  if (!m) throw new Error(`Invalid CW3E cycle "${cycle}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])));
}

/**
 * @param {Date} d
 * @returns {string} YYYYMMDDHH (UTC)
 */
export function cycleString(d) {
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 10);
}

/**
 * Candidate cycles, newest first, stepping back six hours from the cycle at or before `from`.
 * @param {Date} from
 * @param {number} [count]
 * @returns {string[]}
 */
export function candidateCycles(from, count = PROBE_STEPS) {
  const start = Math.floor(from.getTime() / SIX_HOURS_MS) * SIX_HOURS_MS;
  return Array.from({ length: count }, (_, i) => cycleString(new Date(start - i * SIX_HOURS_MS)));
}

/**
 * "Model run 10/04/2026 12 UTC".
 * @param {string} cycle
 * @returns {string}
 */
export function modelRunLabel(cycle) {
  const d = cycleDate(cycle);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `Model run ${mm}/${dd}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')} UTC`;
}

/**
 * @param {unknown} manifest ar-products.json envelope
 * @param {Date} now
 * @returns {{ cycle: string, stale: boolean } | null} null when the manifest holds no cycle
 */
export function resolveCycleFromManifest(manifest, now) {
  const m = /** @type {any} */ (manifest);
  if (!m || typeof m !== 'object' || m.completeness === 'rejected' || !Array.isArray(m.items)) return null;
  const cycles = m.items.map((/** @type {any} */ i) => i?.cycle).filter((/** @type {unknown} */ c) => typeof c === 'string' && /^\d{10}$/.test(c));
  if (cycles.length === 0) return null;
  const cycle = /** @type {string} */ ([...cycles].sort().pop());
  const age = now.getTime() - cycleDate(cycle).getTime();
  return { cycle, stale: m.carriedForward === true || age > STALE_AFTER_MS };
}

/**
 * The manifest item for one product, model, and domain, or null.
 * @param {unknown} manifest
 * @param {string} product
 * @param {string} model
 * @param {string} domain
 * @returns {{ product: string, model: string, domain: string, cycle: string, forecastHours: number[], urls: string[] } | null}
 */
export function manifestItem(manifest, product, model, domain) {
  const items = /** @type {any} */ (manifest)?.items;
  if (!Array.isArray(items)) return null;
  return items.find((/** @type {any} */ i) => i?.product === product && i?.model === model && i?.domain === domain) ?? null;
}

/**
 * Newest complete cycle: every required hour must exist. The last hour is checked first, because a cycle that
 * lacks it is still being written; then the rest, so one missing hour disqualifies the cycle.
 * @param {{ cycles: string[], hours: readonly number[], has: (cycle: string, hour: number) => Promise<boolean> }} args cycles newest first
 * @returns {Promise<{ cycle: string, skipped: { cycle: string, missing: number[] }[] } | null>}
 */
export async function newestCompleteCycle({ cycles, hours, has }) {
  /** @type {{ cycle: string, missing: number[] }[]} */
  const skipped = [];
  const ordered = [...hours].sort((a, b) => b - a);
  for (const cycle of cycles) {
    const last = ordered[0];
    if (last === undefined) return null;
    if (!(await has(cycle, last))) { skipped.push({ cycle, missing: [last] }); continue; }
    const rest = ordered.slice(1);
    const found = await Promise.all(rest.map((h) => has(cycle, h)));
    const missing = rest.filter((_, i) => !found[i]);
    if (missing.length === 0) return { cycle, skipped };
    skipped.push({ cycle, missing });
  }
  return null;
}

/**
 * @param {string} src
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
function loadImage(src, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const img = new Image();
    const done = (/** @type {boolean} */ ok) => resolve(ok);
    img.addEventListener('load', () => done(true), { once: true });
    img.addEventListener('error', () => done(false), { once: true });
    signal?.addEventListener('abort', () => done(false), { once: true });
    img.src = src;
  });
}

/**
 * Loads candidate images stepping back six hours when the manifest is stale.
 * @param {(cycle: string) => string} urlFor
 * @param {Date} now
 * @param {AbortSignal} [signal]
 * @param {(src: string, signal: AbortSignal | undefined) => Promise<boolean>} [load] injectable for tests
 * @returns {Promise<string | null>} the first candidate address that loads, or null
 */
export async function probeCycleInBrowser(urlFor, now, signal, load = loadImage) {
  for (const cycle of candidateCycles(now)) {
    if (signal?.aborted) return null;
    const src = urlFor(cycle);
    if (await load(src, signal)) return src;
  }
  return null;
}
