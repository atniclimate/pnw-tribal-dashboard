// @ts-check
/**
 * Versioned mapping tables (blueprint 3.8). Every alert records mappingApplied. Band, posture, and
 * designation are independent axes. DOM-free.
 *
 * `NWS_MAPPING_TABLE`, `ECCC_MAPPING_TABLE`, `mapNwsDimensions`, and `mapEcccDimensions` are verbatim ports
 * of CAST `packages/alerts-schema/src/mappings.ts` at the commit in tests/fixtures/cast/UPSTREAM.json; the
 * parity test (tests/cast/alerts-mapping.test.mjs) runs CAST's own TypeScript beside these ports over every
 * input combination. The three `atni-cthd-*` tables are the dashboard's own and are provisional (Q8).
 */

/** @typedef {import('../types.js').SeverityBand} SeverityBand */
/** @typedef {import('../types.js').ActionPosture} ActionPosture */
/** @typedef {import('../types.js').AlertConfidence} AlertConfidence */
/** @typedef {import('../types.js').MappingApplied} MappingApplied */
/** @typedef {{ band: SeverityBand, posture: ActionPosture, confidence: AlertConfidence }} MappedAlertDimensions */
/** @typedef {import('../types.js').AlertLifecycleState} AlertLifecycleState */

/** Table names and versions from blueprint 3.8 (the provisional BC tables await ratification, Q8). @type {Readonly<Record<'nws' | 'eccc' | 'bc-rfc' | 'emcr' | 'ntwc', MappingApplied>>} */
export const MAPPING_TABLES = Object.freeze({
  nws: Object.freeze({ name: 'atni-cast-nws-cap', version: '1.0.0' }),
  eccc: Object.freeze({ name: 'atni-cast-eccc-cap', version: '1.0.0' }),
  'bc-rfc': Object.freeze({ name: 'atni-cthd-bcrfc', version: '0.1.0' }),
  emcr: Object.freeze({ name: 'atni-cthd-emcr', version: '0.1.0' }),
  ntwc: Object.freeze({ name: 'atni-cthd-ntwc', version: '0.1.0' }),
});

/** CAST NWS_MAPPING_TABLE (atni-cast-nws-cap 1.0.0), verbatim. */
export const NWS_MAPPING_TABLE = Object.freeze({
  name: 'atni-cast-nws-cap',
  version: '1.0.0',
  severity: Object.freeze(/** @type {Record<string, SeverityBand>} */ ({
    extreme: 'extreme',
    severe: 'severe',
    moderate: 'moderate',
    minor: 'minor',
    unknown: 'unstated',
  })),
  urgency: Object.freeze(/** @type {Record<string, ActionPosture>} */ ({
    immediate: 'act-now',
    expected: 'prepare',
    future: 'prepare',
    past: 'ended',
    unknown: 'monitor',
  })),
  certainty: Object.freeze(/** @type {Record<string, AlertConfidence>} */ ({
    observed: 'observed',
    likely: 'likely',
    possible: 'possible',
    unlikely: 'unknown',
    unknown: 'unknown',
  })),
  eventPosture: Object.freeze(/** @type {ReadonlyArray<{ suffix: string, posture: ActionPosture }>} */ ([
    Object.freeze({ suffix: 'emergency', posture: /** @type {ActionPosture} */ ('act-now') }),
    Object.freeze({ suffix: 'warning', posture: /** @type {ActionPosture} */ ('act-now') }),
    Object.freeze({ suffix: 'watch', posture: /** @type {ActionPosture} */ ('prepare') }),
    Object.freeze({ suffix: 'advisory', posture: /** @type {ActionPosture} */ ('monitor') }),
    Object.freeze({ suffix: 'statement', posture: /** @type {ActionPosture} */ ('monitor') }),
  ])),
});

/** CAST ECCC_MAPPING_TABLE (atni-cast-eccc-cap 1.0.0), verbatim. */
export const ECCC_MAPPING_TABLE = Object.freeze({
  name: 'atni-cast-eccc-cap',
  version: '1.0.0',
  precedence: Object.freeze(['MSC_Impact', 'Colour', 'CAP severity']),
  mscImpact: Object.freeze(/** @type {Record<string, SeverityBand>} */ ({
    extreme: 'extreme',
    high: 'severe',
    severe: 'severe',
    medium: 'moderate',
    moderate: 'moderate',
    'modéré': 'moderate',
    low: 'minor',
    minor: 'minor',
  })),
  colour: Object.freeze(/** @type {Record<string, SeverityBand>} */ ({
    red: 'extreme',
    orange: 'severe',
    yellow: 'moderate',
    jaune: 'moderate',
    green: 'minor',
  })),
  capSeverity: NWS_MAPPING_TABLE.severity,
  urgency: NWS_MAPPING_TABLE.urgency,
  certainty: NWS_MAPPING_TABLE.certainty,
});

/** @param {string | null | undefined} value @returns {string} */
function key(value) {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * CAST lookup: own keys only, so an upstream value such as "constructor" can never reach Object.prototype.
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {string | null | undefined} value
 * @param {T} fallback
 * @returns {T}
 */
function lookup(table, value, fallback) {
  const k = key(value);
  return Object.prototype.hasOwnProperty.call(table, k) ? /** @type {T} */ (table[k]) : fallback;
}

/**
 * Verbatim CAST atni-cast-nws-cap 1.0.0 (mapNwsAlert). The event designation never affects band.
 * @param {{ severity?: string | null, urgency?: string | null, certainty?: string | null, event?: string | null, ended?: boolean }} input
 * @returns {MappedAlertDimensions}
 */
export function mapNwsDimensions(input) {
  /** @type {ActionPosture} */
  let posture = lookup(NWS_MAPPING_TABLE.urgency, input.urgency, /** @type {ActionPosture} */ ('monitor'));
  if (input.ended === true) {
    posture = 'ended';
  } else {
    const event = key(input.event);
    const eventRule = NWS_MAPPING_TABLE.eventPosture.find(({ suffix }) => event.endsWith(suffix));
    if (eventRule !== undefined) posture = eventRule.posture;
  }
  return {
    band: lookup(NWS_MAPPING_TABLE.severity, input.severity, /** @type {SeverityBand} */ ('unstated')),
    posture,
    confidence: lookup(NWS_MAPPING_TABLE.certainty, input.certainty, /** @type {AlertConfidence} */ ('unknown')),
  };
}

/**
 * Verbatim CAST atni-cast-eccc-cap 1.0.0 (mapEcccAlert): MSC_Impact, then Colour, then CAP severity.
 * Event titles never affect band.
 * @param {{ mscImpact?: string | null, colour?: string | null, severity?: string | null, urgency?: string | null, certainty?: string | null, event?: string | null, ended?: boolean }} input
 * @returns {MappedAlertDimensions}
 */
export function mapEcccDimensions(input) {
  const impact = lookup(ECCC_MAPPING_TABLE.mscImpact, input.mscImpact, /** @type {SeverityBand | undefined} */ (undefined));
  const colour = lookup(ECCC_MAPPING_TABLE.colour, input.colour, /** @type {SeverityBand | undefined} */ (undefined));
  const base = lookup(ECCC_MAPPING_TABLE.capSeverity, input.severity, /** @type {SeverityBand} */ ('unstated'));
  const common = mapNwsDimensions(input);
  return { ...common, band: impact ?? colour ?? base };
}

/**
 * atni-cthd-bcrfc 0.1.0 (provisional, Q8). Advisory names are the layer's own coded-value names.
 * @type {Readonly<Record<string, { band: SeverityBand, posture: ActionPosture }>>}
 */
export const BC_RFC_TABLE = Object.freeze({
  'flood warning': Object.freeze({ band: /** @type {SeverityBand} */ ('severe'), posture: /** @type {ActionPosture} */ ('act-now') }),
  'flood watch': Object.freeze({ band: /** @type {SeverityBand} */ ('moderate'), posture: /** @type {ActionPosture} */ ('prepare') }),
  'high streamflow advisory': Object.freeze({ band: /** @type {SeverityBand} */ ('minor'), posture: /** @type {ActionPosture} */ ('monitor') }),
});

/**
 * Band unstated until the maintainer ratifies atni-cthd-bcrfc; posture follows the designation suffix
 * either way (Warning act-now, Watch prepare, Advisory monitor). "No Advisory" is ended.
 * @param {string} advisoryName
 * @param {{ ratified: boolean }} opts
 * @returns {{ band: SeverityBand, posture: ActionPosture }}
 */
export function mapBcRfc(advisoryName, opts) {
  const k = key(advisoryName);
  if (k === 'no advisory' || k === '') return { band: 'unstated', posture: 'ended' };
  const row = Object.prototype.hasOwnProperty.call(BC_RFC_TABLE, k) ? BC_RFC_TABLE[k] : undefined;
  /** @type {ActionPosture} */
  let posture = 'monitor';
  if (row) posture = row.posture;
  else if (k.endsWith('warning')) posture = 'act-now';
  else if (k.endsWith('watch')) posture = 'prepare';
  return { band: opts.ratified && row ? row.band : 'unstated', posture };
}

/**
 * atni-cthd-emcr 0.1.0 (provisional, Q8): Order act-now; Alert prepare; rescinded (or all clear) ended.
 * Band is always unstated: EMCR publishes no impact level.
 * @param {string} status the layer's ORDER_ALERT_STATUS value
 * @returns {{ band: SeverityBand, posture: ActionPosture }}
 */
export function mapEmcr(status) {
  const k = key(status);
  if (k === 'order' || k === 'evacuation order') return { band: 'unstated', posture: 'act-now' };
  if (k === 'alert' || k === 'evacuation alert') return { band: 'unstated', posture: 'prepare' };
  if (k.includes('rescind') || k.includes('all clear') || k.includes('lifted') || k === 'expired') return { band: 'unstated', posture: 'ended' };
  return { band: 'unstated', posture: 'monitor' };
}

/**
 * atni-cthd-ntwc 0.1.0 (provisional): the National Tsunami Warning Center product type (the Atom entry's
 * "Category") sets band and posture. Warning extreme and act-now; Advisory severe and prepare; Watch
 * severe and prepare; Information Statement unstated and monitor; Cancellation ended.
 * @type {Readonly<Record<string, { event: string, band: SeverityBand, posture: ActionPosture }>>}
 */
export const NTWC_TABLE = Object.freeze({
  warning: Object.freeze({ event: 'Tsunami Warning', band: /** @type {SeverityBand} */ ('extreme'), posture: /** @type {ActionPosture} */ ('act-now') }),
  advisory: Object.freeze({ event: 'Tsunami Advisory', band: /** @type {SeverityBand} */ ('severe'), posture: /** @type {ActionPosture} */ ('prepare') }),
  watch: Object.freeze({ event: 'Tsunami Watch', band: /** @type {SeverityBand} */ ('severe'), posture: /** @type {ActionPosture} */ ('prepare') }),
  information: Object.freeze({ event: 'Tsunami Information Statement', band: /** @type {SeverityBand} */ ('unstated'), posture: /** @type {ActionPosture} */ ('monitor') }),
  cancellation: Object.freeze({ event: 'Tsunami Cancellation', band: /** @type {SeverityBand} */ ('unstated'), posture: /** @type {ActionPosture} */ ('ended') }),
});

/**
 * @param {string} category the NTWC "Category" value, for example "Information" or "Warning"
 * @returns {{ event: string, band: SeverityBand, posture: ActionPosture } | null}
 */
export function mapNtwc(category) {
  const k = key(category);
  if (Object.prototype.hasOwnProperty.call(NTWC_TABLE, k)) return /** @type {{ event: string, band: SeverityBand, posture: ActionPosture }} */ (NTWC_TABLE[k]);
  if (k.startsWith('cancel')) return NTWC_TABLE.cancellation ?? null;
  if (k.startsWith('info')) return NTWC_TABLE.information ?? null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// CAST alerts-schema lifecycle resolver (packages/alerts-schema/src/lifecycle.ts), verbatim. Kept with
// the other CAST ports for parity; the dashboard renders with resolveLifecycle in alerts/lifecycle.js.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ alertId: string, eventId: string, sent: string, messageType: 'alert' | 'update' | 'cancel',
 *   references: readonly string[], lifecycleState: AlertLifecycleState, expires: string | null }} LifecycleMessage
 * @typedef {{ alertId: string, eventId: string, sent: string, state: 'superseded' | 'cancelled', replacedByAlertId?: string }} AlertTombstone
 * @typedef {{ eventId: string, lifecycleState: AlertLifecycleState, current: LifecycleMessage | null,
 *   tombstones: readonly AlertTombstone[], memberAlertIds: readonly string[] }} AlertEventIdentity
 * @typedef {{ alertId: string, eventId: string, reason: 'older-sent' | 'duplicate-id' }} AlertLifecycleRejection
 */

/** @param {{ sent: string }} alert @returns {number} */
function parseSent(alert) {
  const parsed = Date.parse(alert.sent);
  if (Number.isNaN(parsed)) throw new Error(`Alert sent is not a parseable timestamp: "${alert.sent}"`);
  return parsed;
}

/**
 * Verbatim port of CAST resolveAlertLifecycle: messages in arrival order; CAP references alias every
 * update and cancel to one stable event identity; older arrivals cannot roll an event backward.
 * @template {LifecycleMessage} M
 * @param {readonly M[]} messages
 * @param {string} [asOf]
 * @returns {{ events: ReadonlyArray<{ eventId: string, lifecycleState: AlertLifecycleState, current: M | null, tombstones: readonly AlertTombstone[], memberAlertIds: readonly string[] }>, rejected: readonly AlertLifecycleRejection[] }}
 */
export function resolveAlertLifecycle(messages, asOf) {
  /** @type {Map<string, { eventId: string, current: M | null, tombstones: AlertTombstone[], memberAlertIds: string[], lifecycleState: AlertLifecycleState }>} */
  const events = new Map();
  /** @type {Map<string, string>} */
  const aliases = new Map();
  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {AlertLifecycleRejection[]} */
  const rejected = [];

  for (const message of messages) {
    if (seenIds.has(message.alertId)) {
      rejected.push({ alertId: message.alertId, eventId: message.eventId, reason: 'duplicate-id' });
      continue;
    }

    const referencedEventIds = message.references
      .map((reference) => aliases.get(reference))
      .filter(/** @returns {eventId is string} */ (eventId) => eventId !== undefined);
    const requestedEventId = referencedEventIds[0] ?? message.references[0] ?? message.eventId;

    const existing = events.get(requestedEventId);
    if (existing?.current !== null && existing?.current !== undefined) {
      if (parseSent(message) < parseSent(existing.current)) {
        rejected.push({ alertId: message.alertId, eventId: requestedEventId, reason: 'older-sent' });
        continue;
      }
      if (parseSent(message) === parseSent(existing.current)) {
        rejected.push({ alertId: message.alertId, eventId: requestedEventId, reason: 'older-sent' });
        continue;
      }
    }

    const event = existing ?? {
      eventId: requestedEventId,
      current: null,
      tombstones: [],
      memberAlertIds: [],
      lifecycleState: /** @type {AlertLifecycleState} */ ('active'),
    };

    if (event.current !== null) {
      /** @type {AlertTombstone} */
      const tomb = {
        alertId: event.current.alertId,
        eventId: event.eventId,
        sent: event.current.sent,
        state: message.messageType === 'cancel' ? 'cancelled' : 'superseded',
        replacedByAlertId: message.alertId,
      };
      event.tombstones.push(tomb);
    }

    /** @type {AlertLifecycleState} */
    const lifecycleState = message.messageType === 'cancel' ? 'cancelled' : 'active';
    const current = Object.freeze({ ...message, eventId: event.eventId, lifecycleState });
    event.current = current;
    event.lifecycleState = lifecycleState;
    event.memberAlertIds.push(message.alertId);
    events.set(event.eventId, event);
    aliases.set(message.alertId, event.eventId);
    for (const reference of message.references) aliases.set(reference, event.eventId);
    seenIds.add(message.alertId);
  }

  if (asOf !== undefined) {
    const asOfTime = Date.parse(asOf);
    if (Number.isNaN(asOfTime)) throw new Error(`Lifecycle asOf is not a parseable timestamp: "${asOf}"`);
    for (const event of events.values()) {
      if (
        event.lifecycleState === 'active'
        && event.current?.expires !== null
        && event.current?.expires !== undefined
        && Date.parse(event.current.expires) <= asOfTime
      ) {
        event.current = Object.freeze({ ...event.current, lifecycleState: /** @type {AlertLifecycleState} */ ('expired') });
        event.lifecycleState = 'expired';
      }
    }
  }

  return Object.freeze({
    events: Object.freeze([...events.values()].map((event) => Object.freeze({
      eventId: event.eventId,
      lifecycleState: event.lifecycleState,
      current: event.current,
      tombstones: Object.freeze(event.tombstones.map((item) => Object.freeze({ ...item }))),
      memberAlertIds: Object.freeze([...event.memberAlertIds]),
    }))),
    rejected: Object.freeze(rejected.map((item) => Object.freeze({ ...item }))),
  });
}

