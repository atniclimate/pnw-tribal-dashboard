// @ts-check
/**
 * types.d.ts is the readable form of the schemas (blueprint 5.0): for each paired interface and schema,
 * the property names agree and the required keys agree (a non-optional TypeScript property is required
 * in the schema).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const types = (await readFile(path.join(ROOT, 'site', 'static', 'js', 'types.d.ts'), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

/**
 * Top-level properties of an exported interface.
 * @param {string} name
 * @returns {Map<string, boolean>} property name to optional
 */
export function interfaceProps(name) {
  const start = types.search(new RegExp(`export interface ${name}(?:<[^>]*>)? \\{`));
  if (start < 0) throw new Error(`interface ${name} not found`);
  let i = types.indexOf('{', start) + 1;
  let depth = 0;
  let stmt = '';
  /** @type {Map<string, boolean>} */
  const props = new Map();
  const flush = () => {
    const m = stmt.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/);
    if (m && m[1]) props.set(m[1], m[2] === '?');
    stmt = '';
  };
  for (; i < types.length; i += 1) {
    const ch = types[i] ?? '';
    if (depth === 0 && ch === '}') { flush(); break; }
    if (ch === '{' || ch === '(' || ch === '<' || ch === '[') depth += 1;
    if (ch === '}' || ch === ')' || (ch === '>' && types[i - 1] !== '=') || ch === ']') depth -= 1;
    if (depth === 0 && (ch === ';' || ch === '\n')) { flush(); continue; }
    stmt += ch;
  }
  return props;
}

/** @param {string} file @param {string[]} pathKeys */
async function schemaNode(file, pathKeys) {
  /** @type {any} */
  let node = JSON.parse(await readFile(path.join(ROOT, 'schemas', file), 'utf8'));
  for (const k of pathKeys) node = node[k];
  return node;
}

const PAIRS = [
  ['NationRecord', 'nation.schema.json', []],
  ['NationIndexEntry', 'nations-index.schema.json', ['properties', 'nations', 'items']],
  ['IdsLock', 'ids-lock.schema.json', []],
  ['Contact', 'contact.schema.json', []],
  ['AgencyRecord', 'agencies.schema.json', ['items']],
  ['SourceRecord', 'source.schema.json', []],
  ['Resource', 'resources.schema.json', ['items']],
  ['CuratedDeclaration', 'declarations-curated.schema.json', ['items']],
  ['NewsSource', 'news-sources.schema.json', ['items']],
  ['ImageryProduct', 'imagery-products.schema.json', ['items']],
  ['EventArchive', 'event.schema.json', []],
  ['Gauge', 'gauges.schema.json', ['properties', 'gauges', 'items']],
  ['GaugeStatus', 'live-gauges-status.schema.json', ['properties', 'items', 'items']],
  ['DashboardAlert', 'dashboard-alert.schema.json', []],
  ['BcHazardItem', 'live-bc-hazards.schema.json', ['properties', 'items', 'items']],
  ['FemaDeclaration', 'live-declarations-fema.schema.json', ['properties', 'items', 'items']],
  ['NewsItem', 'live-news.schema.json', ['properties', 'items', 'items']],
  ['AlertTextItem', 'live-alerts-text.schema.json', ['properties', 'items', 'items']],
  ['AlertGeometryItem', 'live-alerts-geometry.schema.json', ['properties', 'items', 'items']],
  ['LiveEnvelope', 'live-alerts.schema.json', []],
  ['LiveManifest', 'live-manifest.schema.json', []],
  ['BuildInfo', 'build-info.schema.json', []],
];

for (const [iface, file, at] of /** @type {[string, string, string[]][]} */ (PAIRS)) {
  test(`${iface} agrees with ${file}`, async () => {
    const props = interfaceProps(iface);
    const node = await schemaNode(file, at);
    const schemaProps = Object.keys(node.properties ?? {}).sort();
    assert.deepEqual([...props.keys()].sort(), schemaProps, 'property names');
    const required = [...props].filter(([, optional]) => !optional).map(([k]) => k).sort();
    assert.deepEqual(required, [...(node.required ?? [])].sort(), 'required keys');
  });
}
