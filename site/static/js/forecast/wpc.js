// @ts-check
/**
 * WPC QPF and Excessive Rainfall images with exact labels (blueprint 7.3). DOM-free.
 */

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */

/**
 * Display order and exact labels. The file names are the stable names verified on 10/05/2026.
 * @type {readonly { id: string, label: string, file: string, group: 'qpf' | 'ero' }[]}
 */
export const WPC_LABELS = Object.freeze([
  { id: 'wpc-qpf-day-1', label: 'Day 1', file: 'fill_94qwbg.gif', group: 'qpf' },
  { id: 'wpc-qpf-day-2', label: 'Day 2', file: 'fill_98qwbg.gif', group: 'qpf' },
  { id: 'wpc-qpf-day-3', label: 'Day 3', file: 'fill_99qwbg.gif', group: 'qpf' },
  { id: 'wpc-qpf-days-1-3', label: 'Days 1 to 3', file: 'd13_fill.gif', group: 'qpf' },
  { id: 'wpc-qpf-days-4-5', label: 'Days 4 and 5', file: '95ep48iwbg_fill.gif', group: 'qpf' },
  { id: 'wpc-qpf-days-6-7', label: 'Days 6 and 7', file: '97ep48iwbg_fill.gif', group: 'qpf' },
  { id: 'wpc-qpf-7-day-total', label: '7-Day Total', file: 'p168i.gif', group: 'qpf' },
  { id: 'wpc-ero-day-1', label: 'Day 1', file: '94ewbg.gif', group: 'ero' },
  { id: 'wpc-ero-day-2', label: 'Day 2', file: '98ewbg.gif', group: 'ero' },
  { id: 'wpc-ero-day-3', label: 'Day 3', file: '99ewbg.gif', group: 'ero' },
]);

/** Group headings, exact. */
export const WPC_GROUP_TITLES = Object.freeze({
  qpf: 'Quantitative Precipitation Forecast',
  ero: 'Excessive Rainfall Outlook',
});

/**
 * Filters data/imagery/products.yaml to WPC products, in display order. A product whose file name differs from
 * the verified one is dropped rather than shown under the wrong label.
 * @param {ImageryProduct[]} products
 * @returns {ImageryProduct[]}
 */
export function wpcProducts(products) {
  /** @type {ImageryProduct[]} */
  const out = [];
  for (const spec of WPC_LABELS) {
    const p = products.find((x) => x.id === spec.id && x.sourceId === 'wpc-images');
    if (p && p.url.endsWith(`/${spec.file}`)) out.push(p);
  }
  return out;
}

/**
 * The exact label for a WPC product id, or null.
 * @param {string} id
 * @returns {string | null}
 */
export function wpcLabel(id) {
  const spec = WPC_LABELS.find((s) => s.id === id);
  return spec ? `${WPC_GROUP_TITLES[spec.group]}, ${spec.label}` : null;
}
