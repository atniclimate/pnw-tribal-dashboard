// @ts-check
/**
 * Update and Cancel resolution; only current messages render (blueprint 3.7.7). DOM-free.
 *
 * `resolveLifecycle` is the dashboard's render rule (ADR 0007): a message that another message in the
 *   batch references is superseded (or cancelled, when a Cancel references it); a Cancel is never shown;
 *   an alert whose `ends ?? expires` has passed is dropped; an alert the agency marked ended is dropped.
 *   It deliberately does not reject a message because a sibling with the same `sent` claimed the same
 *   event first: NWS splits one product into segments that can reference the same earlier message, and
 *   CAST's single-current-per-event rule would hide every segment but one. CAST's own resolver is ported
 *   verbatim as `resolveAlertLifecycle` in alerts/mapping.js (with CAST's other alerts-schema ports, off the
 *   page's static import graph); on CAST's cases both render the same current set
 *   (tests/cast/alerts-lifecycle.test.mjs).
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').AlertLifecycleState} AlertLifecycleState */

/**
 * True when the alert is past both its `ends` and its `expires` instants (blueprint 3.7.3 "ends ??
 * expires", taken as the later of the two). An NWS message can carry an `ends` earlier than `expires`
 * when one segment holds two hazard periods (10 of 180 footprint alerts on 10/05/2026, for example a
 * Small Craft Advisory that "remains in effect until 1 AM" and again "from 7 AM Monday"); api.weather.gov
 * keeps such a message active until `expires`, so the dashboard does too. When `ends` is later than
 * `expires`, the event outlasts the message and the alert stays until `ends`. An alert with neither is
 * never expired by time.
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {Date} now
 * @returns {boolean}
 */
export function isExpired(alert, now) {
  const times = [alert.ends, alert.expires]
    .filter((t) => typeof t === 'string')
    .map((t) => Date.parse(/** @type {string} */ (t)))
    .filter((t) => !Number.isNaN(t));
  if (times.length === 0) return false;
  return Math.max(...times) <= now.getTime();
}

/**
 * The root of an alert's reference chain: the earliest message it (transitively) references within the
 * batch, else its first reference, else itself (CAST identity rule, without rejection).
 * @param {string} id
 * @param {Map<string, { references: readonly string[] }>} byId
 * @param {Map<string, string>} memo
 * @param {Set<string>} [visiting]
 * @returns {string}
 */
function rootOf(id, byId, memo, visiting = new Set()) {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const msg = byId.get(id);
  if (!msg || msg.references.length === 0 || visiting.has(id)) {
    memo.set(id, id);
    return id;
  }
  visiting.add(id);
  const inBatch = msg.references.find((r) => byId.has(r));
  const root = inBatch !== undefined ? rootOf(inBatch, byId, memo, visiting) : /** @type {string} */ (msg.references[0]);
  visiting.delete(id);
  memo.set(id, root);
  return root;
}

/**
 * References supersede; Cancel cancels its event; ends ?? expires in the past drops the alert. Duplicate
 * alert ids keep the first occurrence. Current alerts come back with `eventId` set to the root of their
 * reference chain and `lifecycleState: 'active'`, in input order.
 * @template {DashboardAlert | DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @param {Date} now
 * @returns {{ current: T[], superseded: string[], cancelled: string[], expired: string[] }}
 */
export function resolveLifecycle(alerts, now) {
  /** @type {Map<string, T>} */
  const byId = new Map();
  for (const a of alerts) if (!byId.has(a.alertId)) byId.set(a.alertId, a);
  /** @type {Set<string>} */
  const cancelledIds = new Set();
  /** @type {Set<string>} */
  const supersededIds = new Set();
  /** Newest `sent` among the messages that reference each id (in the batch or not). @type {Map<string, number>} */
  const newestReferrer = new Map();
  for (const a of byId.values()) {
    const sent = Date.parse(a.sent);
    for (const ref of a.references) {
      if (ref === a.alertId) continue;
      if (!Number.isNaN(sent)) newestReferrer.set(ref, Math.max(newestReferrer.get(ref) ?? -Infinity, sent));
      if (!byId.has(ref)) continue;
      if (a.messageType === 'cancel') cancelledIds.add(ref);
      else supersededIds.add(ref);
    }
  }
  // A late, older message that answers the same earlier message as a newer one is superseded (CAST's
  // older-sent rule); siblings sent at the same instant (segments of one product) all stay.
  for (const a of byId.values()) {
    const sent = Date.parse(a.sent);
    if (a.references.some((ref) => (newestReferrer.get(ref) ?? -Infinity) > sent)) supersededIds.add(a.alertId);
  }
  /** @type {Map<string, string>} */
  const memo = new Map();
  /** @type {T[]} */
  const current = [];
  /** @type {string[]} */
  const expired = [];
  /** @type {string[]} */
  const cancelled = [];
  /** @type {string[]} */
  const superseded = [];
  for (const a of byId.values()) {
    if (a.messageType === 'cancel' || a.lifecycleState === 'cancelled' || a.posture === 'ended') { cancelled.push(a.alertId); continue; }
    if (cancelledIds.has(a.alertId)) { cancelled.push(a.alertId); continue; }
    if (supersededIds.has(a.alertId) || a.lifecycleState === 'superseded') { superseded.push(a.alertId); continue; }
    if (a.lifecycleState === 'expired' || isExpired(a, now)) { expired.push(a.alertId); continue; }
    const eventId = rootOf(a.alertId, byId, memo);
    current.push(eventId === a.eventId && a.lifecycleState === 'active' ? a : { ...a, eventId, lifecycleState: 'active' });
  }
  return { current, superseded, cancelled, expired };
}
