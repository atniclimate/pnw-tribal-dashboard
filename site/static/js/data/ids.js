// @ts-check
/**
 * Stable identifiers for Nations, contacts, and other curated records (blueprint 5.0 and 5.2).
 *
 * DOM-free: imported unchanged by the browser, by Node scripts, and by research lanes that need ids
 * before the registry is built.
 *
 * Rules:
 * - U.S. Tribes: `us-<state>-<slug of full formal name>`, minted once and frozen in
 *   `data/registry/ids.lock.json`. Southeast Alaska: `us-ak-<slug>`.
 * - First Nations: `ca-fn-<ISC band number>`, stable by construction and immune to orthography fixes.
 * - A renamed Nation keeps its id. An id that must change gets an entry in `id-redirects.json`.
 * - Ids are kebab-case ASCII, never reused, and never encode a person.
 */

/** @typedef {import('../types.js').NationId} NationId */
/** @typedef {import('../types.js').IdsLock} IdsLock */
/** @typedef {import('../types.js').IdsLockEntry} IdsLockEntry */
/** @typedef {import('../types.js').IdRedirects} IdRedirects */

/** U.S. states whose Tribes can appear in the registry (the footprint in MIGRATION_DECISIONS.md). */
export const US_STATE_CODES = Object.freeze(['wa', 'or', 'id', 'ca', 'mt', 'nv', 'ak']);

/** Longest slug minted; longer names are cut at a word boundary. */
export const MAX_SLUG_LENGTH = 80;

export const NATION_ID_PATTERN = /^(?:us-(?:wa|or|id|ca|mt|nv|ak)-[a-z0-9]+(?:-[a-z0-9]+)*|ca-fn-[1-9][0-9]{0,4})$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Letters that Unicode decomposition does not reduce to ASCII. Combining marks (acute, caron, comma
 * above, underline, and the rest) are removed by NFKD; these need an explicit choice.
 * @type {Readonly<Record<string, string>>}
 */
const LETTER_MAP = Object.freeze({
  'ł': 'l', 'ɬ': 'l', 'ƛ': 'tl', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ð': 'd',
  'þ': 'th', 'ŋ': 'ng', 'ə': 'e', 'ɛ': 'e', 'ɔ': 'o', 'ı': 'i', 'ʷ': 'w', 'ˀ': '', 'ʸ': 'y',
});

/**
 * Characters that vanish from slugs: glottal stops, pharyngeals, apostrophes and their look-alikes, the
 * ISC `?` placeholder (which stands in for a character the export could not encode), and U+FFFD.
 */
const DROP = /[\u0294\u0295\u02BC\u02BB\u02BD\u02C0\u02C1'\u2018\u2019\u201B`\u00B4?\uFFFD]/g;

/**
 * Kebab-case ASCII slug of a name. Throws when nothing usable remains.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (typeof text !== 'string') throw new TypeError('slugify expects a string');
  let s = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  s = s.replace(DROP, '');
  s = s.replace(/&/g, ' and ');
  s = Array.from(s, (ch) => LETTER_MAP[ch] ?? ch).join('');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > MAX_SLUG_LENGTH) {
    const cut = s.slice(0, MAX_SLUG_LENGTH + 1);
    const at = cut.lastIndexOf('-');
    s = (at > 0 ? cut.slice(0, at) : cut.slice(0, MAX_SLUG_LENGTH)).replace(/-+$/g, '');
  }
  if (s === '') throw new Error(`cannot make a slug from "${text}"`);
  return s;
}

/**
 * Mint the id for a U.S. Tribe from its state and full formal name. Minting is done once; afterwards the id
 * is read from the lock file (see assignNationId) and never re-derived from a name.
 * @param {string} state two-letter state code, any case
 * @param {string} formalName full formal name
 * @returns {NationId}
 */
export function mintUsNationId(state, formalName) {
  const st = String(state).toLowerCase();
  if (!US_STATE_CODES.includes(st)) throw new Error(`state "${state}" is outside the registry footprint`);
  return /** @type {NationId} */ (`us-${st}-${slugify(formalName)}`);
}

/**
 * The id for a First Nation from its ISC band number.
 * @param {number | string} bandNumber
 * @returns {NationId}
 */
export function firstNationId(bandNumber) {
  const n = typeof bandNumber === 'string' && /^\d+$/.test(bandNumber.trim()) ? Number(bandNumber.trim()) : bandNumber;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99999) {
    throw new Error(`"${String(bandNumber)}" is not an ISC band number`);
  }
  return /** @type {NationId} */ (`ca-fn-${n}`);
}

/**
 * @param {unknown} value
 * @returns {value is NationId}
 */
export function isNationId(value) {
  return typeof value === 'string' && NATION_ID_PATTERN.test(value);
}

/**
 * @param {string} id
 * @returns {{ country: 'US', state: string, slug: string } | { country: 'CA', bandNumber: number }}
 */
export function parseNationId(id) {
  if (!isNationId(id)) throw new Error(`"${id}" is not a Nation id`);
  if (id.startsWith('ca-fn-')) return { country: 'CA', bandNumber: Number(id.slice(6)) };
  return { country: 'US', state: id.slice(3, 5), slug: id.slice(6) };
}

/**
 * True when a name carries the ISC `?` placeholder or U+FFFD. Such a name is flagged
 * `name-orthography-needs-nation-source`, can never be marked reviewed, and blocks launch while displayed.
 * @param {string} name
 */
export function hasNamePlaceholder(name) {
  return /[?\uFFFD]/.test(name);
}

/**
 * Follow `id-redirects.json` from an id to its current id. Unknown ids pass through unchanged (the caller
 * decides whether the id exists). Throws on a redirect cycle or a malformed target.
 * @param {string} id
 * @param {IdRedirects | null | undefined} redirects
 * @returns {{ id: string, redirected: boolean, chain: string[] }}
 */
export function resolveNationId(id, redirects) {
  const map = redirects?.redirects ?? {};
  /** @type {string[]} */
  const chain = [id];
  let current = id;
  for (let hop = 0; hop < 32; hop += 1) {
    const next = Object.hasOwn(map, current) ? map[current] : undefined;
    if (next === undefined) return { id: current, redirected: chain.length > 1, chain };
    if (!isNationId(next.to)) throw new Error(`redirect from "${current}" targets "${next.to}", which is not a Nation id`);
    if (chain.includes(next.to)) throw new Error(`redirect cycle: ${[...chain, next.to].join(' -> ')}`);
    chain.push(next.to);
    current = next.to;
  }
  throw new Error(`redirect chain from "${id}" is longer than 32 hops`);
}

/**
 * Return the frozen id for a source record, minting and appending a lock entry only when the key is new.
 * The lock is append-only: existing entries are never changed. A minted id that collides with an existing
 * id under a different key throws, because resolving it needs a person (a reviewed override), not a suffix.
 * @param {IdsLock} lock
 * @param {{ key: string, name: string } & ({ country: 'US', state: string } | { country: 'CA', bandNumber: number })} candidate
 *   `key` is the stable source key, for example `bia-tld:Lummi Tribe of the Lummi Reservation` or `isc:602`.
 * @param {string} mintedAt ISO date (YYYY-MM-DD)
 * @returns {{ id: NationId, minted: boolean, lock: IdsLock }}
 */
export function assignNationId(lock, candidate, mintedAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mintedAt)) throw new Error('mintedAt must be YYYY-MM-DD');
  const known = lock.entries.find((e) => e.key === candidate.key);
  if (known) return { id: /** @type {NationId} */ (known.id), minted: false, lock };
  const id =
    candidate.country === 'CA' ? firstNationId(candidate.bandNumber) : mintUsNationId(candidate.state, candidate.name);
  const clash = lock.entries.find((e) => e.id === id);
  if (clash) {
    throw new Error(`id "${id}" for key "${candidate.key}" collides with key "${clash.key}"; add a reviewed override`);
  }
  /** @type {IdsLockEntry} */
  const entry = { id, key: candidate.key, name: candidate.name, mintedAt };
  return { id, minted: true, lock: { ...lock, entries: [...lock.entries, entry] } };
}

/**
 * Id for a curated record with a fixed prefix, for example `mintPrefixedId('ct', ['wa', 'emd',
 * 'alert-warning-center', '24-7'])` gives `ct-wa-emd-alert-warning-center-24-7`.
 * @param {'ct' | 'res' | 'decl' | 'ag' | 'evt'} prefix
 * @param {string[]} parts
 * @returns {string}
 */
export function mintPrefixedId(prefix, parts) {
  if (!['ct', 'res', 'decl', 'ag', 'evt'].includes(prefix)) throw new Error(`unknown id prefix "${prefix}"`);
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('an id needs at least one part');
  const tail = parts.map((p) => slugify(String(p))).join('-');
  return `${prefix}-${tail}`;
}

/**
 * Contact id (blueprint 5.3), for example `ct-wa-emd-alert-warning-center-24-7`. A Nation contact begins
 * with the Nation id: `mintContactId([nationId, 'emergency-management', '24-7'])`.
 * @param {string[]} parts
 */
export function mintContactId(parts) {
  return mintPrefixedId('ct', parts);
}
