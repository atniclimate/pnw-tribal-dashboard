// @ts-check
/**
 * National Tsunami Warning Center Atom normalizer (blueprint 3.7.2). Takes an already-parsed feed object
 * (the snapshot task parses XML with DOCTYPE and entities disabled). DOM-free.
 *
 * The Atom feed (`PAAQAtom.xml`) carries the center's latest products for Alaska, British Columbia, and
 * the U.S. West Coast. Each entry's summary names its "Category" (Warning, Advisory, Watch, Information,
 * or a cancellation), which sets band and posture through atni-cthd-ntwc 0.1.0. The feed publishes no
 * expiry, so currency is a stated rule: Warning, Advisory, and Watch entries stay current while they are
 * in the feed (the center replaces or cancels them); an Information Statement, which by definition
 * carries no threat, is current for 24 hours after it was issued; a cancellation is never shown.
 */
import { createAlertId } from './model.js';
import { mapNtwc, MAPPING_TABLES } from './mapping.js';
import { designationOf } from './designation.js';

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').Jurisdiction} Jurisdiction */

export const NTWC_SOURCE_ID = 'ntwc-atom';
export const NTWC_AUTHORITY = 'National Tsunami Warning Center';
/** How long an Information Statement stays current after issuance. */
export const NTWC_INFORMATION_CURRENT_MS = 24 * 60 * 60 * 1000;
/** The coasts the center's Atom feed covers inside the footprint. @type {readonly Jurisdiction[]} */
export const NTWC_JURISDICTIONS = Object.freeze(/** @type {Jurisdiction[]} */ (['WA', 'OR', 'BC', 'CA-N', 'AK-SE', 'MARINE']));

/**
 * fast-xml-parser options the snapshot task must use: attributes kept with an `@_` prefix, entities not
 * expanded, the XHTML summary kept as raw text (a stop node), and `entry` and `link` always arrays.
 */
export const NTWC_XML_OPTIONS = Object.freeze({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
  stopNodes: ['feed.entry.summary'],
  /** @param {string} name @returns {boolean} */
  isArray: (name) => name === 'entry' || name === 'link',
});

/**
 * Rejects XML that declares a DOCTYPE or ENTITY before any parsing (entity expansion attacks), as CAST's
 * CAP decoder does.
 * @param {string} text
 * @returns {string}
 */
export function assertSafeXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('NTWC feed must not contain DOCTYPE or ENTITY declarations');
  return text;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string} */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (isRecord(v) && typeof v['#text'] === 'string') return v['#text'];
  return '';
}

/**
 * Plain text from the XHTML summary: tags removed, line breaks kept, the five XML entities and numeric
 * references decoded. Never inserted as HTML anywhere.
 * @param {string} xhtml
 * @returns {string}
 */
export function summaryText(xhtml) {
  return xhtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * The bulletin's own page when it is an https link on the center's host; otherwise null (the panel then
 * links the registry's human page).
 * @param {string} href
 * @returns {string | null}
 */
function bulletinUrl(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && u.hostname === 'www.tsunami.gov' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Tsunami Warning act-now; Advisory and Watch prepare; Information Statement monitor.
 * @param {unknown} feed fast-xml-parser output of PAAQAtom.xml
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics }}
 */
export function normalizeNtwcFeed(feed, ctx) {
  /** @type {AlertDiagnostics} */
  const diagnostics = { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false, notCurrent: 0, cancelled: 0 };
  /** @type {DashboardAlert[]} */
  const alerts = [];
  const root = isRecord(feed) && isRecord(feed.feed) ? feed.feed : null;
  if (!root) {
    diagnostics.itemsFailed = 1;
    diagnostics.collectionRejected = 1;
    return { alerts, diagnostics };
  }
  const author = isRecord(root.author) ? textOf(root.author.name).trim() : '';
  const entries = Array.isArray(root.entry) ? root.entry : root.entry === undefined ? [] : [root.entry];
  for (const entry of entries) {
    try {
      if (!isRecord(entry)) throw new Error('entry must be an object');
      const id = textOf(entry.id).trim();
      const updated = textOf(entry.updated).trim();
      if (id === '' || Number.isNaN(Date.parse(updated))) throw new Error('entry needs an id and a parseable updated time');
      const raw = textOf(entry.summary);
      const text = summaryText(raw);
      const category = /Category:\s*([A-Za-z][A-Za-z ]*?)\s*(?:\n|Bulletin|$)/.exec(text)?.[1] ?? '';
      const row = mapNtwc(category);
      if (!row) throw new Error(`unrecognized NTWC category "${category}"`);
      if (row.posture === 'ended') { diagnostics.cancelled = Number(diagnostics.cancelled) + 1; continue; }
      if (row.event === 'Tsunami Information Statement' && ctx.now.getTime() - Date.parse(updated) > NTWC_INFORMATION_CURRENT_MS) {
        diagnostics.notCurrent = Number(diagnostics.notCurrent) + 1;
        continue;
      }
      const links = Array.isArray(entry.link) ? entry.link : [];
      const bulletin = links.find((l) => isRecord(l) && l['@_rel'] === 'alternate' && typeof l['@_href'] === 'string');
      const href = bulletin && isRecord(bulletin) ? String(bulletin['@_href']) : '';
      const title = textOf(entry.title).trim();
      /** @type {Record<string, string[]>} */
      const parameters = {};
      const lat = textOf(entry['geo:lat']).trim();
      const lon = textOf(entry['geo:long']).trim();
      if (lat) parameters['geo:lat'] = [lat];
      if (lon) parameters['geo:long'] = [lon];
      parameters.category = [category];
      const alertId = createAlertId('ntwc', id);
      /** @type {DashboardAlert} */
      const alert = {
        alertId,
        eventId: alertId,
        sourceId: NTWC_SOURCE_ID,
        sent: updated,
        messageType: 'alert',
        references: [],
        lifecycleState: 'active',
        event: row.event,
        originalDesignation: category,
        band: row.band,
        posture: row.posture,
        confidence: 'unknown',
        effective: updated,
        expires: null,
        geometry: null,
        sourceLanguage: { 'en-US': { headline: title || row.event, description: text } },
        translationAuthority: NTWC_AUTHORITY,
        provenance: {
          agency: 'ntwc',
          originalId: id,
          fetchedAt: ctx.fetchedAt,
          mappingApplied: { ...MAPPING_TABLES.ntwc },
          coverage: { geometryBasis: 'none', geocodes: [] },
        },
        agency: 'ntwc',
        designation: designationOf(row.event, 'ntwc'),
        categories: ['tsunami'],
        zones: [],
        jurisdictions: [...NTWC_JURISDICTIONS],
        marine: false,
        nationIds: [],
        senderName: author || NTWC_AUTHORITY,
        webUrl: bulletinUrl(href),
        parameters,
      };
      if (title) alert.areaDesc = title;
      alerts.push(alert);
    } catch {
      diagnostics.itemsFailed += 1;
    }
  }
  return { alerts, diagnostics };
}
