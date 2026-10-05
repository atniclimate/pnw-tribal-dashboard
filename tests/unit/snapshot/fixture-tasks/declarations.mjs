// @ts-check
/**
 * Test-only snapshot task: groups the dated OpenFEMA capture of DR-4906-WA
 * (tests/fixtures/upstream/openfema-declarations/2026-10-05-dr-4906-wa-multi-county.json) into one
 * declaration, so the runner can be proven before lane L12's real declarations task lands. No Tribal
 * matching is attempted here. Owner: lane L9.
 */

export const QUERY_URL = 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?%24filter=femaDeclarationString+eq+%27DR-4906-WA%27&%24orderby=designatedArea+asc';

/** @type {import('../../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'declarations',
  sourceIds: ['openfema-declarations'],
  cadenceMin: 60,
  outputs: ['declarations-fema.json'],
  async run(ctx) {
    const r = await ctx.http.getJson('openfema-declarations', QUERY_URL);
    const base = { schema: /** @type {const} */ ('cthd.live.declarations-fema/1'), id: 'declarations', sourceIds: ['openfema-declarations'],
      generatedAt: ctx.now.toISOString(), carriedForward: false, diagnostics: {} };
    if (!r.ok) {
      return { 'declarations-fema.json': { ...base, observedAt: r.fetchedAt, asOf: null, asOfBasis: null, completeness: 'rejected',
        failure: { code: r.error.kind, message: r.error.message, at: r.fetchedAt },
        perSource: { 'openfema-declarations': { ok: false, count: 0, asOf: null } }, items: [] } };
    }
    const rows = /** @type {Record<string, any>[]} */ (/** @type {any} */ (r.data).DisasterDeclarationsSummaries ?? []);
    /** @type {Map<string, any>} */
    const groups = new Map();
    for (const row of rows) {
      const key = `fema:${row.femaDeclarationString}`;
      const g = groups.get(key) ?? {
        id: key, disasterNumber: row.disasterNumber, type: row.declarationType, state: row.state,
        region: ['WA', 'OR', 'ID'].includes(row.state) ? String(row.state).toLowerCase() : null,
        tribalRequest: Boolean(row.tribalRequest), title: row.declarationTitle, incidentType: row.incidentType,
        declaredOn: row.declarationDate, incidentBegin: row.incidentBeginDate ?? null, incidentEnd: row.incidentEndDate ?? null,
        closedOn: row.disasterCloseoutDate ?? null, designatedAreas: [], programs: { ih: false, ia: false, pa: false, hm: false },
        nationIds: [], unmatchedTribalArea: null, inFootprint: ['WA', 'OR', 'ID'].includes(row.state),
        sourceUrl: `https://www.fema.gov/disaster/${row.disasterNumber}`,
      };
      g.designatedAreas.push(String(row.designatedArea));
      g.programs.ih ||= Boolean(row.ihProgramDeclared);
      g.programs.ia ||= Boolean(row.iaProgramDeclared);
      g.programs.pa ||= Boolean(row.paProgramDeclared);
      g.programs.hm ||= Boolean(row.hmProgramDeclared);
      groups.set(key, g);
    }
    const items = [...groups.values()];
    const asOf = rows.map((x) => String(x.lastRefresh)).sort().pop() ?? null;
    return { 'declarations-fema.json': { ...base, observedAt: r.fetchedAt, asOf, asOfBasis: asOf ? 'retrieved' : null, completeness: 'complete',
      failure: null, perSource: { 'openfema-declarations': { ok: true, count: rows.length, asOf } }, items } };
  },
};
