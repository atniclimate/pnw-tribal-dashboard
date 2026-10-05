// @ts-check
/**
 * Latest Area Forecast Discussion for an office (blueprint 7.3). DOM-free.
 */
import { getData } from '../core/sources.js';
import { isoOrNull } from './nws-forecast.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

/**
 * One request to the /latest endpoint; the text is returned verbatim for plain-text display.
 * @param {string} wfo three-letter forecast office code from nws-points
 * @param {{ signal?: AbortSignal, now?: Date }} [opts]
 * @returns {Promise<{ text: string | null, issuedAt: string | null, office: string | null, status: StatusSnapshot }>}
 */
export async function loadLatestAfd(wfo, opts = {}) {
  if (!/^[A-Za-z]{3}$/.test(wfo)) throw new Error(`Not a forecast office code: "${wfo}"`);
  const res = await getData('nws-afd', { wfo: wfo.toUpperCase() }, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    asOfOf: (d) => {
      const t = isoOrNull(/** @type {any} */ (d)?.issuanceTime);
      return { asOf: t, asOfBasis: t ? 'issued' : null };
    },
  });
  const d = /** @type {any} */ (res.data);
  const text = typeof d?.productText === 'string' && d.productText.trim() ? d.productText : null;
  return {
    text,
    issuedAt: isoOrNull(d?.issuanceTime),
    office: typeof d?.issuingOffice === 'string' ? d.issuingOffice : null,
    status: res.status,
  };
}
