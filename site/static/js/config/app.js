// @ts-check
/**
 * Application constants: cadences, budgets, freshness defaults, and feature flags (blueprint 3.3, 3.13,
 * 4.6, 8.1). No URLs live here; every endpoint comes from the source registry (core/sources.js).
 * DOM-free. Owner: lane L0.
 */

/** @typedef {import('../types.js').AppConfig} AppConfig */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** @type {Readonly<AppConfig>} */
export const APP = Object.freeze({
  storagePrefix: 'cthd:v1:',
  freshness: Object.freeze({
    // Alert panels: CAST DS-009 freshness, and 2 hours usable (ADR 0007 divergence from CAST's 72 hours).
    alerts: Object.freeze({ freshForMs: 15 * MIN, usableForMs: 2 * HOUR }),
    gauges: Object.freeze({ freshForMs: 30 * MIN, usableForMs: 6 * HOUR }),
    forecasts: Object.freeze({ freshForMs: 60 * MIN, usableForMs: 6 * HOUR }),
  }),
  poll: Object.freeze({
    nwsTopUp: 90_000,
    nwsTopUpActNow: 60_000,
    nwsMin: 30_000,
    eccc: 300_000,
    bcStreams: 300_000,
    snapshotReread: 300_000,
    gauges: 15 * MIN,
    forecasts: 30 * MIN,
    radarTiles: 5 * MIN,
  }),
  net: Object.freeze({
    maxConcurrent: 4,
    timeoutMs: 12_000,
    retries: 2,
    backoffMs: Object.freeze([1_000, 3_000]),
    jitter: 0.2,
    retryAfterCapMs: 30_000,
    pointsTtlMs: HOUR,
  }),
  map: Object.freeze({
    // "Show Map (about 500 KB)" and "Load Interactive Map (about 315 KB)" (blueprint 4.6; budgets.json).
    firstLoadLabelBytes: 500_000,
    interactiveLabelBytes: 315_000,
    loadTimeoutMs: 20_000,
    contextRestoreMs: 5_000,
    tileFailureWindowMs: 10_000,
    featureListCap: 50,
    phoneMaxZoom: 12,
    desktopMaxZoom: 14,
  }),
  flags: Object.freeze({
    // Sources with registry status "candidate" resolve to unavailable unless this is on (blueprint 3.12).
    enableCandidateSources: false,
    serviceWorker: true,
  }),
  contactReviewDays: 180,
  alertMaxZoneFallbackFetches: 6,
});
