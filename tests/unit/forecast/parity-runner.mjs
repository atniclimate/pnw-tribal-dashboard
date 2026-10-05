// @ts-check
/**
 * Child process for gridpoint-qpf.test.mjs: runs the May 2026 aggregator and the port over one fixture in
 * the process zone (set with the TZ environment variable) and prints both results as JSON.
 *   node parity-runner.mjs <fixture-name> <nation-zone> <now-iso>
 */
import { readFileSync } from 'node:fs';
import { aggregateGridpointDaily as legacy } from './legacy-qpf.mjs';
import { aggregateGridpointDaily as ported } from '../../../site/static/js/forecast/gridpoint-qpf.js';

const [name, zone, nowIso] = process.argv.slice(2);
const props = JSON.parse(readFileSync(new URL(`../../fixtures/upstream/nws-gridpoints/${name}`, import.meta.url), 'utf8')).properties;
const now = new Date(/** @type {string} */ (nowIso));
console.log(JSON.stringify({
  processZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  legacy: legacy(props, now),
  ported: ported(props, /** @type {string} */ (zone), now),
}));
