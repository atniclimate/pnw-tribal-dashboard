// @ts-check
/**
 * Snapshot task `ar-products` (blueprint 5.9, 6.4): the newest complete CW3E model cycle for each product,
 * model, and domain in the imagery catalog. CW3E retired every "current" image address, so each candidate
 * cycle (every six hours, newest first) is probed with HEAD requests; a cycle is complete only when every
 * forecast hour exists, so one missing hour sends the search to the previous cycle. The browser has its own
 * fallback probe (site/static/js/forecast/cw3e.js) for when this file is stale.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { FORECAST_HOURS, candidateCycles, cw3eUrl, cycleDate, newestCompleteCycle } from '../../../site/static/js/forecast/cw3e.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_ID = 'cw3e-images';
const CONCURRENCY = 4;

/** Forecast hours that exist per CW3E product family. */
const HOURS_BY_PRODUCT = Object.freeze(/** @type {Record<string, readonly number[]>} */ ({
  ivt_map: FORECAST_HOURS,
  iwv_map: FORECAST_HOURS,
  landfalltool_ivt250_probability: [384],
  arscale_map_mean: [168],
}));

/**
 * Product, model, and domain from a catalog folder URL ".../images/{product}/v1/{model}/{domain}/".
 * @param {string} url
 * @returns {{ product: string, model: string, domain: string } | null}
 */
export function parseFolder(url) {
  const m = /\/images\/([A-Za-z0-9_-]+)\/v1\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url);
  return m ? { product: /** @type {string} */ (m[1]), model: /** @type {string} */ (m[2]), domain: /** @type {string} */ (m[3]) } : null;
}

/**
 * @param {string} [root]
 * @returns {Promise<{ template: string, combos: { product: string, model: string, domain: string }[] }>}
 */
export async function loadConfig(root = ROOT) {
  const source = /** @type {any} */ (loadYaml(await readFile(path.join(root, 'data', 'sources', 'cw3e-images.yaml'), 'utf8'), { schema: CORE_SCHEMA }));
  const products = /** @type {any[]} */ (loadYaml(await readFile(path.join(root, 'data', 'imagery', 'products.yaml'), 'utf8'), { schema: CORE_SCHEMA }));
  const combos = products.filter((p) => p.sourceId === SOURCE_ID).map((p) => parseFolder(p.url)).filter((c) => c !== null);
  return { template: source.urlTemplate, combos: /** @type {any} */ (combos) };
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'ar-products',
  sourceIds: [SOURCE_ID],
  cadenceMin: 60,
  outputs: ['ar-products.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    const { template, combos } = await loadConfig();
    const cycles = candidateCycles(ctx.now);
    /** @type {{ product: string, model: string, domain: string, cycle: string, forecastHours: number[], urls: string[] }[]} */
    const items = [];
    let firstError = '';
    let probes = 0;
    let skippedCycles = 0;
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const c = combos[next++];
        if (!c) return;
        const hours = HOURS_BY_PRODUCT[c.product] ?? FORECAST_HOURS;
        const found = await newestCompleteCycle({
          cycles, hours,
          has: async (cycle, fh) => {
            probes += 1;
            const res = await ctx.http.head(SOURCE_ID, cw3eUrl(template, { ...c, cycle, fh }), { timeoutMs: 20000 });
            if (!res.ok && res.error.kind !== 'http') firstError ||= `${res.error.kind}: ${res.error.message}`;
            return res.ok;
          },
        });
        if (!found) continue;
        skippedCycles += found.skipped.length;
        items.push({ ...c, cycle: found.cycle, forecastHours: [...hours], urls: hours.map((fh) => cw3eUrl(template, { ...c, cycle: found.cycle, fh })) });
      }
    }));
    items.sort((a, b) => `${a.product}${a.model}${a.domain}`.localeCompare(`${b.product}${b.model}${b.domain}`));
    const newest = items.map((i) => i.cycle).sort().pop() ?? null;
    const rejected = items.length === 0;
    const asOf = newest ? cycleDate(newest).toISOString() : null;
    return {
      'ar-products.json': {
        schema: 'cthd.live.ar-products/1',
        id: 'ar-products',
        sourceIds: [SOURCE_ID],
        generatedAt: at,
        observedAt: at,
        asOf,
        asOfBasis: asOf ? 'model-run' : null,
        completeness: rejected ? 'rejected' : items.length === combos.length ? 'complete' : 'partial',
        carriedForward: false,
        failure: rejected ? { code: 'upstream', message: firstError || 'no complete cycle found', at } : null,
        perSource: { [SOURCE_ID]: { ok: !rejected, count: items.length, asOf } },
        diagnostics: { combos: combos.length, resolved: items.length, probes, skippedCycles },
        items,
      },
    };
  },
};
