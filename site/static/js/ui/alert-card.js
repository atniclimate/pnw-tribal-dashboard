// @ts-check
/**
 * Alert card: event as issued, designation badge, band chip, posture, area, times in the right zone; expands to description and What to Do verbatim (blueprint 7.2). DOM module.
 *
 * The title is the event exactly as the agency issued it; no derived word replaces it. Band, designation,
 * and posture are three separate marks, and each carries a word, so color is never the only signal. The full
 * text (description and CAP instruction) is source-authored and is rendered unaltered: paragraphs and line
 * breaks are kept, nothing is truncated, summarized, or reworded. For Environment and Climate Change Canada
 * alerts a Français toggle swaps to the agency's own French block; a missing language is never synthesized.
 * The declaration cards (federal and curated) and the British Columbia notice card share this card shell, so
 * they live here too.
 *
 * Owner: lane L11.
 */
import { h } from '../core/dom.js';
import { formatAsOf } from '../core/time.js';
import { languageBlockFor, splitZoneKey } from '../alerts/model.js';
import { CURATED_KIND_WORDS, ISSUER_LEVEL_WORDS, curatedStatus, curatedStatusText, isoDateToUs } from '../declarations/curated.js';
import { femaProgramWords, femaStatusText, femaTypeWord } from '../declarations/openfema.js';
import { initDisclosure } from './disclosure.js';

/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */

/** @type {Readonly<Record<string, string>>} */
export const BAND_WORDS = Object.freeze({ extreme: 'Extreme', severe: 'Severe', moderate: 'Moderate', minor: 'Minor', unstated: 'Unstated' });
/** @type {Readonly<Record<string, string>>} */
export const DESIGNATION_WORDS = Object.freeze({ emergency: 'Emergency', warning: 'Warning', watch: 'Watch', advisory: 'Advisory', statement: 'Statement', other: 'Other' });
/** @type {Readonly<Record<string, string>>} */
export const POSTURE_WORDS = Object.freeze({ 'act-now': 'Act Now', prepare: 'Prepare', monitor: 'Monitor', ended: 'Ended' });
/** @type {Readonly<Record<string, string>>} */
const ZONE_WORDS = Object.freeze({ forecast: 'Forecast zone', county: 'County zone', fire: 'Fire weather zone', marine: 'Marine zone' });

/**
 * A stable element id for an alert id (alert ids hold characters ids cannot, such as colons and slashes).
 * @param {string} alertId
 * @returns {string}
 */
export function cardIdFor(alertId) {
  let hash = 5381;
  for (let i = 0; i < alertId.length; i += 1) hash = ((hash * 33) ^ alertId.charCodeAt(i)) >>> 0;
  return `alert-${alertId.replace(/[^A-Za-z0-9]+/g, '-').slice(-40)}-${hash.toString(36)}`;
}

/**
 * The later of `ends` and `expires` (the same rule the lifecycle uses to drop an alert), or null.
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @returns {string | null}
 */
export function endsAtOf(alert) {
  const times = [alert.ends, alert.expires].filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return null;
  return /** @type {string} */ (times.reduce((a, b) => (Date.parse(/** @type {string} */ (a)) >= Date.parse(/** @type {string} */ (b)) ? a : b)));
}

/**
 * Source text as paragraphs, keeping every line break the agency wrote.
 * @param {string} text
 * @returns {HTMLElement[]}
 */
export function textParagraphs(text) {
  return String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim() !== '').map((p) => {
    const lines = p.split('\n');
    return h('p', {}, ...lines.flatMap((line, i) => (i === 0 ? [line] : [h('br'), line])));
  });
}

/**
 * @param {string} iso
 * @param {string} timeZone
 * @returns {HTMLElement}
 */
function timeEl(iso, timeZone) {
  return h('time', { datetime: iso }, formatAsOf(iso, timeZone));
}

/**
 * The expanded card is built on first open, so a list of hundreds of cards stays light.
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {Record<string, AlertLanguageBlock> | null} text
 * @param {{ lang: 'en' | 'fr', loadFailed: boolean, loading: boolean }} view
 * @returns {Node[]}
 */
function bodyContent(alert, text, view) {
  /** @type {Node[]} */
  const out = [];
  if (text === null || Object.keys(text).length === 0) {
    if (view.loading) out.push(h('p', { class: 'panel-note' }, 'Loading full text.'));
    else {
      out.push(h('p', { class: 'panel-note' }, view.loadFailed
        ? 'The full text could not be loaded right now. Read the original from the issuing agency.'
        : 'The issuing agency published no text for this alert here. Read the original from the issuing agency.'));
    }
  } else {
    const picked = languageBlockFor(text, view.lang);
    if (picked) {
      const langAttr = picked.tag;
      if (view.lang === 'fr' && !picked.requestedAvailable) {
        out.push(h('p', { class: 'panel-note' }, 'The issuing agency did not publish French text for this alert. The English text is shown.'));
      }
      out.push(h('div', { class: 'alert-card__text', lang: langAttr },
        picked.block.headline ? h('p', {}, h('strong', {}, picked.block.headline)) : null,
        textParagraphs(picked.block.description),
        picked.block.instruction
          ? h('section', { class: 'what-to-do' }, h('h5', {}, view.lang === 'fr' && picked.requestedAvailable ? 'Que faire' : 'What to Do'), textParagraphs(picked.block.instruction))
          : null));
    }
  }
  if (alert.zones.length > 0) {
    out.push(h('div', {}, h('h5', {}, 'Zones Named in This Alert'),
      h('ul', { class: 'bullets' }, alert.zones.map((key) => {
        const { type, code } = splitZoneKey(key);
        return h('li', {}, `${ZONE_WORDS[type] ?? 'Zone'} ${code}`);
      }))));
  }
  const basis = alert.provenance?.coverage?.geometryBasis;
  if (basis === 'zone') out.push(h('p', { class: 'caption' }, 'Map coverage: whole forecast zones named in the alert, drawn dashed on the map.'));
  else if (basis === 'polygon') out.push(h('p', { class: 'caption' }, 'Map coverage: the area the forecaster drew, shown solid on the map.'));
  else if (basis === 'none') out.push(h('p', { class: 'caption' }, 'Area shown as text; map outline unavailable.'));
  if (alert.webUrl) out.push(h('p', {}, h('a', { href: alert.webUrl, target: '_blank', rel: 'noopener' }, `Read the original from ${alert.senderName}`)));
  return out;
}

/**
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {{ timeZone: string, lang?: string, selected?: boolean, lastConfirmedAt?: string | null, headingLevel?: 3 | 4,
 *   onShowOnMap?: (alertId: string) => void, loadText?: (alertId: string) => Promise<Record<string, AlertLanguageBlock> | null> }} opts
 *   `lastConfirmedAt` is set when the card's source is not live, so the card says when it was last confirmed.
 * @returns {HTMLElement}
 */
export function alertCard(alert, opts) {
  const tz = opts.timeZone;
  /** @type {'en' | 'fr'} */
  let lang = opts.lang === 'fr' ? 'fr' : 'en';
  const fullText = /** @type {DashboardAlert} */ (alert).sourceLanguage;
  /** @type {Record<string, AlertLanguageBlock> | null} */
  let text = fullText && Object.keys(fullText).length > 0 ? fullText : null;
  let loading = false;
  let loadFailed = false;
  let built = false;

  const cardId = cardIdFor(alert.alertId);
  const bodyId = `${cardId}-body`;
  const ends = endsAtOf(alert);
  const start = alert.onset ?? alert.effective;

  const body = h('div', { class: 'alert-card__body', id: bodyId, hidden: '' });
  const toggle = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'toggle-text', 'aria-expanded': 'false' }, 'Full Alert Text'));
  initDisclosure(toggle, body);
  toggle.setAttribute('aria-expanded', 'false');
  body.hidden = true;

  function paint() {
    body.replaceChildren(...bodyContent(alert, text, { lang, loadFailed, loading }));
    if (alert.agency === 'eccc') {
      const switchLang = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'toggle-language', lang: lang === 'fr' ? 'en' : 'fr', 'aria-label': lang === 'fr' ? 'Show the English text' : 'Afficher le texte en français' }, lang === 'fr' ? 'English' : 'Français');
      switchLang.addEventListener('click', () => { lang = lang === 'fr' ? 'en' : 'fr'; paint(); });
      body.prepend(h('p', {}, switchLang));
    }
  }

  async function ensureText() {
    if (text !== null || !opts.loadText || loading) return;
    loading = true;
    paint();
    try {
      const all = await opts.loadText(alert.alertId);
      text = all && Object.keys(all).length > 0 ? all : null;
      loadFailed = all === null;
    } catch {
      loadFailed = true;
    }
    loading = false;
    paint();
  }

  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    if (!built) { built = true; paint(); }
    void ensureText();
  });

  const showOnMap = opts.onShowOnMap
    ? h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'show-on-map', 'data-alert-id': alert.alertId }, 'Show on Map')
    : null;
  showOnMap?.addEventListener('click', () => opts.onShowOnMap?.(alert.alertId));

  const card = h('article', {
    class: 'alert-card',
    id: cardId,
    'data-band': alert.band,
    'data-alert-id': alert.alertId,
    'data-agency': alert.agency,
    'aria-current': opts.selected ? 'true' : null,
  },
  h('div', { class: 'alert-card__labels' },
    h('span', { class: `designation-badge designation-badge--${alert.designation}` }, DESIGNATION_WORDS[alert.designation] ?? 'Other'),
    h('span', { class: `band-chip band-chip--${alert.band}` }, BAND_WORDS[alert.band] ?? 'Unstated'),
    h('span', { class: `posture-label posture-label--${alert.posture}` }, POSTURE_WORDS[alert.posture] ?? '')),
  h(opts.headingLevel === 4 ? 'h4' : 'h3', { class: 'alert-card__title' }, alert.event),
  alert.areaDesc ? h('p', { class: 'alert-card__meta' }, alert.areaDesc) : null,
  h('p', { class: 'alert-card__meta' },
    start ? ['Effective ', timeEl(start, tz), '. '] : null,
    ends ? ['Expires ', timeEl(ends, tz), '. '] : 'No expiry time is published. ',
    alert.senderName ? `Issued by ${alert.senderName}.` : null),
  opts.lastConfirmedAt ? h('p', { class: 'alert-card__meta' }, 'Last confirmed ', timeEl(opts.lastConfirmedAt, tz), '.') : null,
  h('p', { class: 'alert-card__actions' }, showOnMap, toggle),
  body);
  toggle.setAttribute('aria-controls', bodyId);
  return card;
}

/**
 * Opens a card's full text if it is closed (used when "Show on Map" lands on an alert).
 * @param {HTMLElement} card
 * @returns {void}
 */
export function expandCard(card) {
  const toggle = /** @type {HTMLButtonElement | null} */ (card.querySelector('[data-action="toggle-text"]'));
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
}

/**
 * Federal declaration card: one disaster, one card, every designated area listed once. The status sentence
 * states dates and closeout, never "active".
 * @param {import('../types.js').FemaDeclaration} d
 * @param {{ nationNames: string[] }} opts the registry names of the Nations the designated areas matched
 * @returns {HTMLElement}
 */
export function femaDeclarationCard(d, opts) {
  const programs = femaProgramWords(d.programs);
  return h('article', { class: 'alert-card', 'data-band': 'unstated', 'data-kind': 'fema-declaration', 'data-declaration-id': d.id },
    h('div', { class: 'alert-card__labels' },
      h('span', { class: 'designation-badge designation-badge--statement' }, femaTypeWord(d)),
      d.tribalRequest ? h('span', { class: 'tag--sovereignty' }, 'Tribal Request') : null),
    h('h3', { class: 'alert-card__title' }, `${d.id.slice('fema:'.length)}: ${d.title}`),
    h('p', { class: 'alert-card__meta' }, femaStatusText(d)),
    d.incidentType ? h('p', { class: 'alert-card__meta' }, `Incident type: ${d.incidentType}.`) : null,
    h('p', { class: 'alert-card__meta' }, programs.length > 0 ? `Programs declared: ${programs.join(', ')}.` : 'FEMA lists no program as declared in this data.'),
    opts.nationNames.length > 3
      ? h('details', { class: 'disclosure', 'data-nations': '' }, h('summary', {}, `Tribal Nations Named in the Designated Areas (${opts.nationNames.length})`),
        h('ul', { class: 'bullets' }, opts.nationNames.map((n) => h('li', {}, n))))
      : opts.nationNames.length > 0 ? h('p', { class: 'alert-card__meta' }, `Tribal Nations named in the designated areas: ${opts.nationNames.join('; ')}.`) : null,
    h('details', { class: 'disclosure' },
      h('summary', {}, `Designated Areas (${d.designatedAreas.length})`),
      h('ul', { class: 'bullets', 'data-designated-areas': '' }, d.designatedAreas.map((a) => h('li', {}, a)))),
    h('p', {}, h('a', { href: d.sourceUrl, target: '_blank', rel: 'noopener' }, 'Read the FEMA declaration page')));
}

/**
 * Curated declaration card; its status is worked out here from its own dates.
 * @param {import('../types.js').CuratedDeclaration} d
 * @param {{ now: Date }} opts
 * @returns {HTMLElement}
 */
export function curatedDeclarationCard(d, opts) {
  const status = curatedStatus(d, opts.now);
  const tribal = d.issuer.type === 'tribal' || d.issuer.type === 'first-nation';
  return h('article', { class: 'alert-card', 'data-band': 'unstated', 'data-kind': 'curated-declaration', 'data-declaration-id': d.id, 'data-status': status.kind },
    h('div', { class: 'alert-card__labels' },
      h('span', { class: 'designation-badge designation-badge--statement' }, CURATED_KIND_WORDS[d.kind] ?? d.kind),
      tribal ? h('span', { class: 'tag--sovereignty' }, 'Tribal Declaration') : null),
    h('h3', { class: 'alert-card__title' }, d.title),
    h('p', { class: 'alert-card__meta' }, `${ISSUER_LEVEL_WORDS[d.issuer.type] ?? 'Issuer'}: ${d.issuer.name}. Issued ${isoDateToUs(d.issuedOn)}.`),
    h('p', { class: 'alert-card__meta' }, `${curatedStatusText(status)}. Verified ${isoDateToUs(d.verifiedAt)}. Review due ${isoDateToUs(d.reviewBy)}.`),
    d.femaDisasterNumber ? h('p', { class: 'alert-card__meta' }, `Related federal declaration: ${d.femaDisasterNumber}.`) : null,
    h('p', {}, h('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, `${d.source.title} (${d.source.publisher})`)));
}

/**
 * British Columbia provincial notice card (evacuation orders and alerts, River Forecast Centre advisories).
 * These are not CAP alerts and are never merged into alert counts.
 * @param {import('../types.js').BcHazardItem} i
 * @param {{ timeZone: string }} opts
 * @returns {HTMLElement}
 */
export function bcHazardCard(i, opts) {
  const kind = i.kind === 'evacuation-order' ? 'Evacuation Order' : i.kind === 'evacuation-alert' ? 'Evacuation Alert' : 'Advisory';
  return h('article', { class: 'alert-card', 'data-band': i.band },
    h('div', { class: 'alert-card__labels' },
      h('span', { class: 'designation-badge designation-badge--statement' }, kind),
      h('span', { class: `posture-label posture-label--${i.posture}` }, POSTURE_WORDS[i.posture] ?? '')),
    h('h3', { class: 'alert-card__title' }, i.title),
    h('p', { class: 'alert-card__meta' }, [i.status, i.issuedBy ? `Issued by ${i.issuedBy}.` : '', i.updatedAt ? `Updated ${formatAsOf(i.updatedAt, opts.timeZone)}.` : ''].filter(Boolean).join(' ')));
}
