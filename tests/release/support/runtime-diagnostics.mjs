// @ts-check
/**
 * Shared helpers for the release specs (offline.spec.mjs and offline-diagnostics.spec.mjs).
 *
 * 1. installRuntimeErrorSink: a runtime error sink that survives navigations. The page's window `error` and
 *    `unhandledrejection` listeners report through a context binding into a Node array, so a document that is
 *    torn down (navigation, offline switch) can no longer take its evidence with it. The in-page array is kept.
 * 2. classifyPageErrors: a narrow, stack-based classifier for one WebKit behavior. Playwright's WebKit driver
 *    promotes every console message with level error and source javascript to a `pageerror`, including the
 *    engine's own "Fetch API cannot load <url> due to access control checks." diagnostic for a fetch that was
 *    caught by the page (cancelled by navigation or failed at the network). The classifier accepts such a record
 *    only when the first stack line has that exact shape for a registered URL AND every stack frame is
 *    `attempt` or `execute` in js/core/net.js, the one guarded fetch call site. Everything else stays fatal.
 */

/** Same-origin data directories the dashboard reads (core/net.js fetchLocal). */
const LOCAL_DATA_PATH = /^\/pnw-tribal-dashboard\/data\/(?:live|ref|geo|registry|curated)\/[a-z0-9/_-]+\.json$/;
/** Registered cross-origin hosts and the only paths this classifier accepts on them (verified source registry). */
const REGISTERED_REMOTE = Object.freeze({
  'https://api.weather.gov': /^\/alerts\/active$/,
  'https://www.fema.gov': /^\/api\/open\/v2\/DisasterDeclarationsSummaries$/,
});
const DIAGNOSTIC_FIRST_LINE = /^Fetch API cannot load (\S+) due to access control checks\.$/;

/**
 * @typedef {{ kind: 'error' | 'unhandledrejection', message: string, url: string }} RuntimeErrorRecord
 */

/**
 * Installs the navigation-surviving runtime error sink on a browser context. Call before the first navigation.
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<RuntimeErrorRecord[]>} the live array; every reported window error or unhandled rejection is pushed to it
 */
export async function installRuntimeErrorSink(context) {
  /** @type {RuntimeErrorRecord[]} */
  const records = [];
  await context.exposeBinding('__reportRuntimeError', (source, kind, message) => {
    records.push({ kind: kind === 'unhandledrejection' ? 'unhandledrejection' : 'error', message: String(message), url: source.frame.url() });
  });
  await context.addInitScript(() => {
    /** @type {string[]} */
    const errors = [];
    Reflect.set(globalThis, '__releaseRuntimeErrors', errors);
    /**
     * @param {string} kind
     * @param {string} message
     */
    const report = (kind, message) => {
      errors.push(message);
      try {
        const send = Reflect.get(globalThis, '__reportRuntimeError');
        if (typeof send === 'function') Promise.resolve(send(kind, message)).catch(() => undefined);
      } catch { /* the in-page array above still holds it */ }
    };
    globalThis.addEventListener('error', (event) => report('error', event.message));
    globalThis.addEventListener('unhandledrejection', (event) => report('unhandledrejection', String(event.reason)));
  });
  return records;
}

/**
 * Whether a diagnostic URL is one of the registered fetch targets.
 * @param {string} raw
 * @param {string} origin the origin the specs serve the artifact from, such as http://localhost:8089
 * @returns {boolean}
 */
function isRegisteredUrl(raw, origin) {
  /** @type {URL} */
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
  if (url.origin === origin) return LOCAL_DATA_PATH.test(url.pathname);
  const remote = Object.entries(REGISTERED_REMOTE).find(([host]) => host === url.origin);
  return remote !== undefined && url.protocol === 'https:' && remote[1].test(url.pathname);
}

/**
 * Classifies one pageerror as the WebKit native fetch diagnostic from the guarded net.js call site.
 * Reads only `error.stack`: Playwright's WebKit driver synthesizes it as the console text followed by
 * `    at <function> (<url>:<line>:<column>)` frames, and the name/message split mangles `https://`.
 * @param {{ stack?: string | undefined }} error
 * @param {string} origin the origin the specs serve the artifact from, such as http://localhost:8089
 * @returns {boolean}
 */
export function isNativeFetchDiagnostic(error, origin) {
  const lines = (error.stack ?? '').split('\n');
  const first = DIAGNOSTIC_FIRST_LINE.exec(lines[0] ?? '');
  if (!first || !isRegisteredUrl(first[1] ?? '', origin)) return false;
  const frames = lines.slice(1);
  if (frames.length === 0) return false;
  const frame = new RegExp(`^\\s+at (?:attempt|execute) \\(${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pnw-tribal-dashboard/v/[0-9a-f]{12}/js/core/net\\.js:\\d+:\\d+\\)$`);
  return frames.every((line) => frame.test(line));
}

/**
 * Splits pageerrors into native WebKit fetch diagnostics (evidence) and everything else (fatal).
 * Only the WebKit project may match; any other engine leaves every record fatal.
 * @template {{ stack?: string | undefined }} E
 * @param {E[]} errors
 * @param {{ webkit: boolean, origin: string }} options
 * @returns {{ diagnostics: E[], fatal: E[] }}
 */
export function classifyPageErrors(errors, { webkit, origin }) {
  const diagnostics = webkit ? errors.filter((error) => isNativeFetchDiagnostic(error, origin)) : [];
  return { diagnostics, fatal: errors.filter((error) => !diagnostics.includes(error)) };
}

/**
 * A JSON-safe copy of a pageerror for attachments and assertion messages.
 * @param {Error} error
 * @returns {{ name: string, message: string, stack: string }}
 */
export function describePageError(error) {
  return { name: error.name, message: error.message, stack: error.stack ?? '' };
}
