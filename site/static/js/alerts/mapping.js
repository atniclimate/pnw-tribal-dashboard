// @ts-check
/**
 * Versioned mapping tables (blueprint 3.8). Every alert records mappingApplied. Band, posture, and designation are independent axes. DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').SeverityBand} SeverityBand */
/** @typedef {import('../types.js').ActionPosture} ActionPosture */
/** @typedef {import('../types.js').AlertConfidence} AlertConfidence */
/** @typedef {import('../types.js').MappingApplied} MappingApplied */

const NOT_IMPLEMENTED = 'not implemented';

/** Table names and versions from blueprint 3.8 (the provisional BC tables await ratification, Q8). @type {Readonly<Record<'nws' | 'eccc' | 'bc-rfc' | 'emcr' | 'ntwc', MappingApplied>>} */
export const MAPPING_TABLES = Object.freeze({
  nws: Object.freeze({ name: 'atni-cast-nws-cap', version: '1.0.0' }),
  eccc: Object.freeze({ name: 'atni-cast-eccc-cap', version: '1.0.0' }),
  'bc-rfc': Object.freeze({ name: 'atni-cthd-bcrfc', version: '0.1.0' }),
  emcr: Object.freeze({ name: 'atni-cthd-emcr', version: '0.1.0' }),
  ntwc: Object.freeze({ name: 'atni-cthd-ntwc', version: '0.1.0' }),
});

/**
 * Verbatim CAST atni-cast-nws-cap 1.0.0.
 * @param {{ severity?: string | null, urgency?: string | null, certainty?: string | null, event?: string | null, ended?: boolean }} input
 * @returns {{ band: SeverityBand, posture: ActionPosture, confidence: AlertConfidence }}
 */
export function mapNwsDimensions(input) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Verbatim CAST atni-cast-eccc-cap 1.0.0 (MSC_Impact, then Colour, then CAP severity).
 * @param {{ mscImpact?: string | null, colour?: string | null, severity?: string | null, urgency?: string | null, certainty?: string | null, event?: string | null, ended?: boolean }} input
 * @returns {{ band: SeverityBand, posture: ActionPosture, confidence: AlertConfidence }}
 */
export function mapEcccDimensions(input) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Band unstated until the maintainer ratifies atni-cthd-bcrfc.
 * @param {string} advisoryName
 * @param {{ ratified: boolean }} opts
 * @returns {{ band: SeverityBand, posture: ActionPosture }}
 */
export function mapBcRfc(advisoryName, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Order act-now; Alert prepare; rescinded ended.
 * @param {string} status
 * @returns {{ band: SeverityBand, posture: ActionPosture }}
 */
export function mapEmcr(status) {
  throw new Error(NOT_IMPLEMENTED);
}
