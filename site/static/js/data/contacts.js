// @ts-check
/**
 * Compiled contacts: loading, ordering, and Nation scoping (blueprint 5.3). DOM-free.
 *
 * STUB (lane L0). Owner: lane L13. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').Contact} Contact */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * data/curated/contacts.json.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<Contact[]>>}
 */
export async function loadContacts(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * 911 first (static), then the Nation, county or regional district, state or province, and federal lines.
 * @param {NationRecord | null} nation
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function contactsFor(nation, contacts, now) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Past reviewDue renders the "Verification Due" tag.
 * @param {Contact} contact
 * @param {Date} now
 * @returns {boolean}
 */
export function isVerificationDue(contact, now) {
  throw new Error(NOT_IMPLEMENTED);
}
