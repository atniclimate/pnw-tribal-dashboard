// @ts-check
/**
 * Priority limiter: at most four concurrent upstream requests per page, served by priority 0 (alerts) to 3 (media and zone fallbacks) (blueprint 3.2).
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Priority} Priority */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * A limiter instance; tests create their own.
 * @param {{ maxConcurrent: number }} opts
 * @returns {{ run<T>(priority: Priority, task: () => Promise<T>, signal?: AbortSignal): Promise<T>, pending(): number }}
 */
export function createLimiter(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The page-wide limiter used by core/net.js.
 * @returns {{ run<T>(priority: Priority, task: () => Promise<T>, signal?: AbortSignal): Promise<T>, pending(): number }}
 */
export function sharedLimiter() {
  throw new Error(NOT_IMPLEMENTED);
}
