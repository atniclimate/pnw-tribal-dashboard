// @ts-check
/** URL contract for the connected workspace. Unknown campaign/embed keys survive writes. */
import { parseQuery } from '../core/url-state.js';

export const WORKSPACE_VIEWS = Object.freeze(['overview', 'forecast', 'rivers']);
/** @type {import('../types.js').UrlStateSchema} */
const SCHEMA = {
  n: { type: 'nation-id' }, view: { type: 'enum', values: WORKSPACE_VIEWS },
  j: { type: 'enum-list', values: ['wa', 'or', 'id', 'bc', 'ca-n', 'mt-w', 'nv-n', 'ak-se', 'marine'] },
  hz: { type: 'list' }, des: { type: 'list' }, band: { type: 'list' }, src: { type: 'list' },
  a: { type: 'string' }, g: { type: 'string' }, units: { type: 'enum', values: ['us', 'metric'] },
  day: { type: 'string' }, range: { type: 'enum', values: ['3', '7'] },
  period: { type: 'string' }, grange: { type: 'enum', values: ['24', '72', '168', 'all'] },
  gmetric: { type: 'enum', values: ['primary', 'secondary'] },
  layers: { type: 'list' }, lowdata: { type: 'flag' },
};
/** @param {string} search @returns {import('../types.js').UrlState} */
export function workspaceState(search) {
  const state = parseQuery(search, SCHEMA);
  return { ...state, view: state.view ?? 'overview' };
}
/** @param {import('../types.js').UrlState} state */
export function scopeKey(state) { return JSON.stringify([state.n ?? null, state.j ?? []]); }
/** @param {string | null} id @returns {import('../types.js').UrlState} */
export function nationPatch(id) { return { n: id ?? undefined, j: undefined, a: undefined, g: undefined, day: undefined, period: undefined }; }
