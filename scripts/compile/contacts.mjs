// @ts-check
/**
 * Compile data/contacts/*.csv into site/data/curated/contacts.json (blueprint 5.3, 6.3; agencies.yaml is
 * compiled by curated.mjs): validate rows (schemas/contact-row.schema.json), map columns to
 * schemas/contact.schema.json, compute
 * needs-reverification from reviewDue, resolve conflicts.csv to preferred rows, and enforce the
 * named-person rule.
 *
 * SKELETON (lane L0). Owner: lane L6.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {import('./all.mjs').CompileContext} ctx
 * @returns {Promise<import('./all.mjs').CompileResult>}
 */
export async function compileContacts(ctx) {
  /** @type {string[]} */
  let csvs = [];
  try { csvs = (await readdir(path.join(ctx.root, 'data', 'contacts'))).filter((n) => n.endsWith('.csv')); } catch { /* no inputs yet */ }
  if (csvs.length === 0) return { outputs: [], skipped: 'no data/contacts/*.csv yet (lane L6)' };
  throw new Error('not implemented (lane L6)');
}
