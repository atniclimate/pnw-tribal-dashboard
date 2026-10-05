// @ts-check
/**
 * Designation from the event as issued (blueprint 3.8). DOM-free.
 *
 * NWS: the event name's last word (Emergency, Warning, Watch, Advisory, Statement); anything else is
 * "other" (for example Air Quality Alert, Hazardous Weather Outlook, Evacuation Immediate). ECCC publishes
 * the designation itself as `alert_type`, which the ECCC normalizer passes here as the event when present;
 * French names are recognized by their leading word (avertissement, veille, avis, bulletin).
 */

/** @typedef {import('../types.js').Agency} Agency */
/** @typedef {import('../types.js').Designation} Designation */

/** @type {ReadonlyArray<[RegExp, Designation]>} */
const SUFFIX_RULES = Object.freeze([
  [/\bemergency$/, 'emergency'],
  [/\bwarning$/, 'warning'],
  [/\bwatch$/, 'watch'],
  [/\badvisory$/, 'advisory'],
  [/\bstatement$/, 'statement'],
]);

/** @type {ReadonlyArray<[RegExp, Designation]>} */
const FRENCH_RULES = Object.freeze([
  [/^alerte\b/, 'warning'],
  [/^avertissement\b/, 'warning'],
  [/^veille\b/, 'watch'],
  [/^avis\b/, 'advisory'],
  [/^bulletin\b/, 'statement'],
]);

/** @type {ReadonlySet<string>} */
const ECCC_ALERT_TYPES = new Set(['warning', 'watch', 'advisory', 'statement']);

/**
 * Suffix rules: Emergency, Warning, Watch, Advisory, Statement; else other.
 * @param {string} event the event as issued, or for ECCC its alert_type when the caller has it
 * @param {Agency} agency
 * @returns {Designation}
 */
export function designationOf(event, agency) {
  const e = String(event ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (e === '') return 'other';
  if (agency === 'eccc' && ECCC_ALERT_TYPES.has(e)) return /** @type {Designation} */ (e);
  for (const [re, d] of SUFFIX_RULES) if (re.test(e)) return d;
  if (agency === 'eccc') for (const [re, d] of FRENCH_RULES) if (re.test(e)) return d;
  if (agency === 'ntwc' && /information/.test(e)) return 'statement';
  return 'other';
}

/**
 * Solid for Emergency and Warning, outline for Watch, left bar for Advisory, text only for Statement.
 * "Other" renders as text only (the quietest form), so it never borrows a stronger shape.
 * @param {Designation} designation
 * @returns {'solid' | 'outline' | 'bar' | 'text'}
 */
export function designationShape(designation) {
  switch (designation) {
    case 'emergency':
    case 'warning':
      return 'solid';
    case 'watch':
      return 'outline';
    case 'advisory':
      return 'bar';
    default:
      return 'text';
  }
}
