// @ts-check
/**
 * Registry records for unit tests of core/net.js and core/sources.js. These are test inputs describing real
 * endpoints' shape (URLs mirror data/sources/*.yaml); they carry no observations.
 */

/**
 * @param {Partial<import('../../../../site/static/js/types.js').SourceRecord> & { id: string }} over
 * @returns {import('../../../../site/static/js/types.js').SourceRecord}
 */
export function record(over) {
  return /** @type {any} */ ({
    title: over.id,
    owner: 'Test Owner',
    url: 'https://api.weather.gov/alerts/active',
    humanUrl: 'https://www.weather.gov/',
    license: 'public domain',
    attribution: 'National Weather Service',
    cadence: 'event-driven',
    region: 'us',
    coverage: ['WA'],
    kind: 'api-geojson',
    status: 'active',
    deprecation: null,
    access: { mode: 'direct', cors: { status: 'verified-wildcard', acao: '*', origin: 'https://atniclimate.github.io', checkedAt: '2026-10-04', evidence: 'test' } },
    usedBy: ['dashboard'],
    verifiedAt: '2026-10-04',
    ...over,
  });
}
