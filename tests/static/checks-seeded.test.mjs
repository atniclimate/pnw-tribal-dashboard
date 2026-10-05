// @ts-check
/**
 * Seeded violations for the L15 checks (blueprint 12.3 acceptance): each check must fail on the violation it
 * exists to catch, and pass on the clean case beside it. Pure functions only; no check reads the working tree
 * here except the lint test, which runs the repository's own ESLint configuration on in-memory sources.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ESLint } from 'eslint';
import { cspProblems, expectedCsp, hostOf, isMapPage, writeCsp } from '../../scripts/check/csp.mjs';
import { panelProblems, panelsOf } from '../../scripts/check/panels.mjs';
import { fileProblems as copyProblems, jsStrings } from '../../scripts/check/copy.mjs';
import { codeOnly, dataProblems, fileProblems as fabProblems } from '../../scripts/check/no-fabrication.mjs';
import { geometryRows, mapRows, pageRows } from '../../scripts/check/budgets.mjs';
import { contactGates, crossReferences, footprintGate, honestyGates, nameGates } from '../../scripts/check/validate-data.mjs';
import { renderDataMd } from '../../scripts/compile/sources.mjs';

/** @param {Record<string, any>} over */
const source = (over) => ({
  id: 'x', url: 'https://api.example.test/v1', access: { mode: 'direct' }, usedBy: ['alerts'], status: 'active', ...over,
});
const SOURCES = [
  source({ id: 'nws', url: 'https://api.weather.gov/alerts/active', access: { mode: 'direct+snapshot' } }),
  source({ id: 'carto', url: 'https://x', urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', access: { mode: 'tiles' } }),
  source({ id: 'goes', url: 'https://cdn.star.nesdis.noaa.gov/GOES18/a.jpg', access: { mode: 'image' }, usedBy: ['forecasts'] }),
  source({ id: 'vid', url: 'https://video.example.test/a.mp4', access: { mode: 'video' }, usedBy: ['forecasts'] }),
  source({ id: 'snap', url: 'https://snap.example.test/', access: { mode: 'snapshot' } }),
];

/** @param {string} csp @param {string} body */
const page = (csp, body = '') => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body data-page="alerts">${body}</body></html>`;
const MAP_BODY = '<section class="panel" data-panel="alerts-map" data-sources="nws" data-map-panel></section>';

describe('check:csp', () => {
  test('hosts are derived by access mode and page, with template wildcards', () => {
    const csp = expectedCsp('alerts', SOURCES);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /img-src 'self' data: https:\/\/\*\.basemaps\.cartocdn\.com;/);
    assert.match(csp, /connect-src 'self' https:\/\/\*\.basemaps\.cartocdn\.com https:\/\/api\.weather\.gov;/);
    assert.doesNotMatch(csp, /snap\.example|goes|video\.example/);
    assert.match(expectedCsp('forecasts', SOURCES), /img-src 'self' data: https:\/\/cdn\.star\.nesdis\.noaa\.gov; media-src 'self' https:\/\/video\.example\.test;/);
    assert.equal(hostOf('https://{s}.tiles.test/{z}/{x}/{y}.png'), '*.tiles.test');
  });

  test('only the embed generator may frame, and only this site', () => {
    assert.match(expectedCsp('embed', SOURCES), /frame-src 'self';/);
    for (const id of ['alerts', 'forecasts', 'dashboard', null]) assert.match(expectedCsp(id, SOURCES), /frame-src 'none';/);
  });

  test('a generated page passes, and a map page carries worker-src and the tile host in both directives', () => {
    const html = page(expectedCsp('alerts', SOURCES), MAP_BODY);
    assert.ok(isMapPage(html));
    assert.deepEqual(cspProblems(html, SOURCES), []);
  });

  test('a blob: source, unsafe-eval, and unsafe-inline are rejected', () => {
    const base = expectedCsp('alerts', SOURCES);
    for (const [bad, re] of /** @type {[string, RegExp][]} */ ([
      [base.replace("worker-src 'self'", "worker-src 'self' blob:"), /blob:/],
      [base.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), /unsafe-eval/],
      [base.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"), /unsafe-inline/],
    ])) assert.match(cspProblems(page(bad), SOURCES).join('\n'), re);
  });

  test('an unregistered host and a missing tile host are detected', () => {
    const base = expectedCsp('alerts', SOURCES);
    assert.match(cspProblems(page(base.replace("connect-src 'self'", "connect-src 'self' https://evil.example.test")), SOURCES).join('\n'), /differs from the registry-derived policy/);
    const noTile = base.replace(/ https:\/\/\*\.basemaps\.cartocdn\.com/g, '');
    const problems = cspProblems(page(noTile, MAP_BODY), SOURCES).join('\n');
    assert.match(problems, /lacks tile host \*\.basemaps\.cartocdn\.com in img-src/);
    assert.match(problems, /lacks tile host \*\.basemaps\.cartocdn\.com in connect-src/);
  });

  test('a map page without worker-src is detected', () => {
    const noWorker = expectedCsp('alerts', SOURCES).replace("worker-src 'self'; ", '');
    assert.match(cspProblems(page(noWorker, MAP_BODY), SOURCES).join('\n'), /lacks worker-src 'self'/);
  });

  test('--write is idempotent and repairs a stale line', () => {
    const stale = page("default-src 'self'", MAP_BODY);
    const fixed = writeCsp(stale, SOURCES);
    assert.deepEqual(cspProblems(fixed, SOURCES), []);
    assert.equal(writeCsp(fixed, SOURCES), fixed);
  });
});

describe('check:panels', () => {
  const panel = (/** @type {string} */ attrs) => `<section class="panel" data-panel="p1" ${attrs}></section>`;
  test('a panel without data-sources, or naming an unregistered id, fails', () => {
    const reg = new Set(['nws']);
    assert.match(panelProblems(panel(''), reg).join(), /has no data-sources/);
    assert.match(panelProblems(panel('data-sources=""'), reg).join(), /has no data-sources/);
    assert.match(panelProblems(panel('data-sources="nws ghost"'), reg).join(), /unregistered source "ghost"/);
    assert.deepEqual(panelProblems(panel('data-sources="nws"'), reg), []);
  });
  test('duplicate panel names fail and comments are ignored', () => {
    const html = `${panel('data-sources="nws"')}${panel('data-sources="nws"')}<!-- <div data-panel="ghost"> -->`;
    assert.equal(panelsOf(html).length, 2);
    assert.match(panelProblems(html, new Set(['nws'])).join(), /more than once/);
  });
});

describe('check:copy', () => {
  test('an em dash fails everywhere except the exempt paths', () => {
    assert.match(copyProblems('site/usage/index.html', '<p>one — two</p>').join(), /em dash/);
    assert.match(copyProblems('data/news.yaml', 'a: "x — y"').join(), /em dash/);
    assert.deepEqual(copyProblems('site/classic/index.html', '<p>one — two tribal</p>'), []);
    assert.deepEqual(copyProblems('tests/fixtures/upstream/x.json', '{"a":"b — c"}'), []);
  });
  test('lowercase tribe, tribal, and treaty fail in visible text but not in urls, ids, or classes', () => {
    assert.match(copyProblems('site/a/index.html', '<p>The tribal council met.</p>').join(), /lowercase "tribal"/);
    assert.match(copyProblems('site/a/index.html', '<p>Rights under a treaty.</p>').join(), /lowercase "treaty"/);
    assert.deepEqual(copyProblems('site/a/index.html', '<p class="tribal-card"><a href="https://x.test/tribal/">Tribal Nations and the Treaty</a> see https://x.test/tribal-map</p>'), []);
    assert.match(copyProblems('site/static/js/pages/x.js', "el.textContent = 'Contact the tribe office';").join(), /lowercase "tribe"/);
    assert.deepEqual(copyProblems('site/static/js/pages/x.js', "const id = 'tribal-map'; // the tribal map"), []);
  });
  test('visible dates must be MM/DD/YYYY', () => {
    assert.match(copyProblems('site/a/index.html', '<p>Updated 2026-10-05.</p>').join(), /ISO date/);
    assert.match(copyProblems('site/a/index.html', '<p>Updated 10/5/2026.</p>').join(), /not MM\/DD\/YYYY/);
    assert.deepEqual(copyProblems('site/a/index.html', '<p>Updated 10/05/2026.</p><time datetime="2026-10-05T00:00Z">10/05/2026</time>'), []);
  });
  test('a listed short form shown as a Nation name fails', () => {
    const html = '<h2 data-nation-name>Lummi</h2>';
    assert.match(copyProblems('site/a/index.html', html, { shortForms: new Set(['lummi']) }).join(), /short form/);
  });
  test('the string scanner skips comments and reads template text', () => {
    assert.deepEqual(jsStrings("// 'no'\nconst a = 'x y'; /* 'z' */ const b = `p ${q('in')} r`;"), ['x y', 'p ', ' r']);
  });
});

describe('check:no-fabrication', () => {
  test('a numeric array of five or more values in pages/ or ui/ fails; four values and other dirs pass', () => {
    assert.match(fabProblems('site/static/js/pages/x.js', 'const s = [1, 2.5, 3, 4, 5];').join(), /numeric array literal/);
    assert.deepEqual(fabProblems('site/static/js/ui/x.js', 'const s = [1, 2, 3, 4];'), []);
    assert.deepEqual(fabProblems('site/static/js/core/x.js', 'const s = [1, 2, 3, 4, 5, 6];'), []);
    assert.deepEqual(fabProblems('site/static/js/ui/x.js', "const s = '[1, 2, 3, 4, 5]'; // [1, 2, 3, 4, 5]"), []);
    assert.equal(codeOnly("a '[1,2]' b").includes('1,2'), false);
  });
  test('sample, placeholder, simulated, dummy, fake, and lorem fail as values', () => {
    for (const w of ['sample', 'placeholder', 'simulated', 'dummy', 'fake', 'Lorem']) {
      assert.match(fabProblems('site/a/index.html', `<p>${w} reading</p>`).join(), new RegExp(w, 'i'));
    }
    assert.match(dataProblems('data/x.yaml', { a: [{ note: 'a simulated value' }] }).join(), /simulated/);
    assert.deepEqual(dataProblems('data/x.yaml', { placeholder: 'ok as a key', b: 'a real value' }), []);
    assert.match(fabProblems('site/static/js/ui/x.js', "t.textContent = 'a sample value';").join(), /sample/);
  });
  test('fixtures, mocks, and samples outside tests/ fail', () => {
    assert.match(fabProblems('site/data/fixtures/a.json', '').join(), /outside tests/);
    assert.match(fabProblems('data/sample/a.json', '').join(), /outside tests/);
    assert.match(fabProblems('site/static/js/core/net.mock.js', '').join(), /outside tests/);
    assert.deepEqual(fabProblems('tests/fixtures/a.json', ''), []);
  });
});

describe('check:budgets', () => {
  const budgets = {
    bytes: {
      htmlPerPage: { gzipMax: 12288 }, cssCritical: { gzipMax: 20480 }, jsStaticGraph: { gzipMax: 46080 }, fontsPreloaded: { gzipMax: 46080 },
      requestWithoutTap: { max: 307200 }, mapInteractive: { maplibreVendoredMax: 337920 }, mapOutline: { topojsonClientApprox: 3072 },
    },
    geometry: {
      hqPoints: { rawMax: 40960 }, boundariesOverview: { rawMax: 614400, gzipMax: 184320 }, boundaryDetailTotal: { rawMax: 15728640 },
      nwsZones: { rawMax: 460800, gzipMax: 153600 }, ecccRegions: { rawMax: 204800 }, outlines: { rawMax: 122880 }, gaugesStatus: { gzipMax: 81920 },
    },
  };
  test('every per-page row fails one byte over and passes at the limit', () => {
    const at = pageRows(budgets, { html: 12288, css: 20480, js: 46080, fonts: 46080 }, 'p');
    assert.ok(at.every((r) => r.ok));
    const over = pageRows(budgets, { html: 12289, css: 20481, js: 46081, fonts: 46081 }, 'p');
    assert.equal(over.filter((r) => !r.ok).length, 4);
  });
  test('both map rows are measured: the vendored MapLibre set and the outline set', () => {
    const ok = mapRows(budgets, { maplibre: [{ file: 'a.mjs', gzip: 200000 }, { file: 'b.mjs', gzip: 130000 }], topojson: [{ file: 't.js', gzip: 2800 }] });
    assert.deepEqual(ok.map((r) => r.row.split(' ')[0]), ['mapInteractive.maplibreVendoredMax', 'requestWithoutTap.max', 'requestWithoutTap.max', 'mapOutline.topojsonClientApprox']);
    assert.ok(ok.every((r) => r.ok));
    const grown = mapRows(budgets, { maplibre: [{ file: 'a.mjs', gzip: 200000 }, { file: 'b.mjs', gzip: 140000 }], topojson: [{ file: 't.js', gzip: 7000 }] });
    assert.deepEqual(grown.filter((r) => !r.ok).map((r) => r.row.split(' ')[0]), ['mapInteractive.maplibreVendoredMax', 'mapOutline.topojsonClientApprox']);
    const big = mapRows(budgets, { maplibre: [{ file: 'a.mjs', gzip: 310000 }], topojson: [] });
    assert.equal(big.filter((r) => !r.ok).length, 1);
  });
  test('geometry rows apply to the files that exist', () => {
    const rows = geometryRows(budgets, [
      { file: 'data/geo/hq-points.json', raw: 50000, gzip: 9000 },
      { file: 'data/geo/boundaries/a.json', raw: 1000, gzip: 500 },
      { file: 'data/geo/outlines.topo.json', raw: 100000, gzip: 20000 },
    ]);
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.row), ['geometry.hqPoints.rawMax']);
    assert.equal(rows.length, 3);
  });
});

describe('validate:data gates', () => {
  /** @param {Record<string, any>} over @returns {import('../../scripts/check/validate-data.mjs').Corpus} */
  const corpus = (over) => ({
    sourceIds: new Set(['bia-lar']), nations: [], productionNationIds: new Set(['us-wa-a']), contacts: [], agencyIds: new Set(['wa-em']),
    eventIds: new Set(['ev-1']), resources: [], declarations: [], gaugeIds: new Set(['nwps:AAAA1']), footprint: null, fetchIds: [],
    // Production detailRef resolves under site/data (the runtime fetches data/<detailRef>), not site/data/registry.
    registryFiles: new Set(['site/data/geo/boundaries/us-wa-a.json']), ...over,
  });
  const nation = (/** @type {Record<string, any>} */ over) => ({
    file: 'site/data/registry/nations/us-wa-a.json',
    rec: { id: 'us-wa-a', name: 'Alpha Tribe', aliases: [], review: { status: 'draft' }, boundary: { detailRef: 'geo/boundaries/us-wa-a.json', parts: [{ sourceId: 'bia-lar' }] }, hq: { sourceId: 'bia-lar' }, contactIds: [], gauges: [], ...over },
  });
  const TODAY = new Date('2026-10-05T00:00:00Z');

  test('cross-references: unresolved ids and unregistered fetchJson ids fail', () => {
    assert.deepEqual(crossReferences(corpus({ nations: [nation({})] })).problems, []);
    const bad = crossReferences(corpus({
      nations: [nation({ boundary: { detailRef: 'geo/boundaries/missing.json', parts: [{ sourceId: 'ghost' }] }, gauges: ['nwps:NOPE1'], contactIds: ['c9'] })],
      contacts: [{ file: 'c row 2', rec: { id: 'c1', nation_id: 'us-wa-zzz', agency_id: 'nope' } }],
      resources: [{ file: 'r #1', rec: { nationId: 'us-wa-zzz' } }],
      declarations: [{ file: 'd #1', rec: { issuer: { nationId: 'us-wa-a' }, eventId: 'ev-9' } }],
      fetchIds: [{ file: 'site/static/js/x.js', id: 'ghost-src' }],
    })).problems.join('\n');
    for (const re of [/detailRef .* does not resolve/, /sourceId ghost is not registered/, /gauges nwps:NOPE1/, /contactIds c9/, /nation_id us-wa-zzz/, /agency_id nope/, /nationId us-wa-zzz/, /eventId ev-9/, /fetchJson\('ghost-src'\)/]) assert.match(bad, re);
  });

  test('names: U+FFFD fails, a reviewed name with "?" fails, a draft name with "?" warns, a short form fails', () => {
    assert.match(nameGates(corpus({ nations: [nation({ name: 'Bad � Name' })] })).problems.join(), /U\+FFFD/);
    assert.match(nameGates(corpus({ nations: [nation({ name: '?aqam', review: { status: 'reviewed' } })] })).problems.join(), /contains "\?"/);
    const draft = nameGates(corpus({ nations: [nation({ name: '?aqam' })] }));
    assert.deepEqual(draft.problems, []);
    assert.equal(draft.warnings.length, 1);
    assert.match(nameGates(corpus({ nations: [nation({ name: 'Alpha', aliases: ['alpha'] })] })).problems.join(), /short form/);
  });

  test('honesty: a resource without a source, an event item in resources, a declaration without source.url', () => {
    const g = honestyGates(corpus({
      resources: [{ file: 'r #1', rec: { title: 't', verifiedAt: '2026-10-04' } }, { file: 'r #2', rec: { url: 'https://x.test', verifiedAt: '2026-10-04', category: 'event' } }],
      declarations: [{ file: 'd #1', rec: { source: {} } }],
    })).problems.join('\n');
    assert.match(g, /r #1: curated resource has no source/);
    assert.match(g, /r #2: an event item belongs in the archive/);
    assert.match(g, /d #1: curated declaration has no source\.url/);
  });

  test('contacts: stale verification fails, past review_due warns, person rule and person-like email fail', () => {
    const row = (/** @type {Record<string, any>} */ over) => ({ file: 'c row 2', rec: { id: 'c1', nation_id: 'us-wa-a', published_by_nation: 'false', source_url: 'https://other.test/p', ...over } });
    const f = contactGates(corpus({ contacts: [row({ verified_at: '2025-09-01', review_due: '2026-01-01' })] }), TODAY);
    assert.match(f.problems.join(), /more than 365 days old/);
    assert.match(f.warnings.join(), /review_due 2026-01-01 has passed/);
    assert.match(contactGates(corpus({ contacts: [row({ verified_at: '2026-10-01', person: 'Role Holder' })] }), TODAY).problems.join(), /person value needs published_by_nation true/);
    assert.match(contactGates(corpus({ contacts: [row({ verified_at: '2026-10-01', email: 'jane.smith@example.test' })] }), TODAY).problems.join(), /looks like a person/);
    assert.deepEqual(contactGates(corpus({ contacts: [row({ verified_at: '2026-10-01', email: 'emergency.management@example.test' })] }), TODAY).problems, []);
    const ok = contactGates(corpus({
      nations: [nation({ website: 'https://www.alpha.example/' })],
      contacts: [row({ verified_at: '2026-10-01', published_by_nation: 'true', source_url: 'https://alpha.example/contact', person: 'Role Holder', email: 'jane.smith@alpha.example' })],
    }), TODAY);
    assert.deepEqual(ok.problems, []);
  });

  test('footprint: ratified false is a warning, never a failure', () => {
    const f = footprintGate(corpus({ footprint: { ratified: false } }));
    assert.deepEqual(f.problems, []);
    assert.equal(f.warnings.length, 1);
    assert.deepEqual(footprintGate(corpus({ footprint: { ratified: true } })).warnings, []);
  });
});

describe('lint rules the harness relies on (seeded)', () => {
  const eslint = new ESLint({ cwd: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  /** @param {string} code @param {string} file */
  const lint = async (code, file) => (await eslint.lintText(code, { filePath: file })).flatMap((r) => r.messages.map((m) => m.message));
  test('Math.random, flyTo, setHTML, a MapLibre import outside the loader, and an unregistered https literal fail', async () => {
    assert.match((await lint('export const r = Math.random();\n', 'site/static/js/pages/seed.js')).join(), /Math\.random/);
    assert.match((await lint('export const f = (m) => m.flyTo({});\n', 'site/static/js/map/seed.js')).join(), /flyTo/);
    assert.match((await lint('export const f = (p) => p.setHTML("x");\n', 'site/static/js/map/seed.js')).join(), /setHTML/);
    assert.match((await lint("import m from '../../vendor/maplibre-gl-6.12.0/maplibre-gl.mjs';\nexport default m;\n", 'site/static/js/map/seed.js')).join(), /map\/loader\.js/);
    assert.match((await lint("export const u = 'https://api.unregistered.test/x';\n", 'site/static/js/pages/seed.js')).join(), /registry/);
  });
});

describe('DATA.md rendering', () => {
  const items = [
    { owner: 'B Agency', title: 'Beta', access: { mode: 'direct' }, license: 'Public domain | no warranty', status: 'active', kind: 'api-json', verifiedAt: '2026-10-04' },
    { owner: 'A Agency', title: 'Alpha', access: { mode: 'tiles' }, license: 'ODbL', status: 'active-pending-terms', kind: 'xyz-tiles', verifiedAt: '2026-10-05' },
    { owner: 'ATNI Climate', title: 'Own', access: { mode: 'build' }, license: 'Copyright', status: 'active', kind: 'file', verifiedAt: '2026-10-05' },
    { owner: 'Z', title: 'Old', access: { mode: 'direct' }, license: 'x', status: 'retired', kind: 'api-json', verifiedAt: '2025-01-01' },
  ];
  test('is deterministic, sorted, MM/DD/YYYY, pending-marked, free of em dashes, and omits retired sources', () => {
    const a = renderDataMd(items);
    assert.equal(a, renderDataMd([...items].reverse()));
    assert.ok(a.indexOf('A Agency') < a.indexOf('B Agency'));
    assert.match(a, /\| 10\/05\/2026 \|/);
    assert.match(a, /ODbL \(pending\)/);
    assert.match(a, /Public domain \/ no warranty/);
    assert.ok(!a.includes('—') && !a.includes('Old'));
    assert.ok(a.indexOf('## Dashboard Files') > a.indexOf('Beta'));
  });
});
