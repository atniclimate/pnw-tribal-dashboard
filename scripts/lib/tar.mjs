// @ts-check
/**
 * Minimal tar reader for `git archive` output (ustar with pax headers), used by assemble-site.mjs to
 * restore the previous asset generation without depending on the platform's tar. Owner: lane L9.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;

/** @param {Buffer} buf @param {number} start @param {number} len */
function str(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

/** @param {Buffer} buf @param {number} start @param {number} len */
function octal(buf, start, len) {
  const s = str(buf, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/**
 * Parse pax extended header records ("<len> key=value\n").
 * @param {Buffer} data
 * @returns {Record<string, string>}
 */
function pax(data) {
  /** @type {Record<string, string>} */
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number.parseInt(data.subarray(i, sp).toString('ascii'), 10);
    if (!(len > 0)) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * List the regular files in a tar archive.
 * @param {Buffer} tar
 * @returns {{ name: string, data: Buffer }[]}
 */
export function readTar(tar) {
  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  /** @type {string | null} */
  let nextName = null;
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { nextName = pax(data).path ?? nextName; continue; }
    if (type === 'L') { nextName = str(data, 0, data.length); continue; }
    if (type === 'g') continue;
    const prefix = str(header, 345, 155);
    const name = nextName ?? (prefix ? `${prefix}/${str(header, 0, 100)}` : str(header, 0, 100));
    nextName = null;
    if (type === '0' || type === '\0') files.push({ name, data: Buffer.from(data) });
  }
  return files;
}

/**
 * Extract the files under `prefix` (for example `site/static/`) into `dest`, with the prefix removed.
 * @param {Buffer} tar
 * @param {string} prefix
 * @param {string} dest
 * @returns {Promise<number>} files written
 */
export async function extractTar(tar, prefix, dest) {
  let n = 0;
  for (const f of readTar(tar)) {
    if (!f.name.startsWith(prefix)) continue;
    const rel = f.name.slice(prefix.length);
    if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '') || path.isAbsolute(rel)) continue;
    const target = path.join(dest, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.data);
    n++;
  }
  return n;
}
