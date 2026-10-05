// @ts-check
/**
 * Types shared by pages/forecasts.js and its lazily loaded view modules (ui/forecast-view-*.js). No runtime
 * code: the page reaches this file only through type imports, so it never loads in a browser.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../forecast/nation-context.js').NationContext} NationContext */

/**
 * What the page hands each view module.
 * @typedef {{
 *   nation: () => NationContext | null,
 *   nationReady: () => Promise<NationContext | null>,
 *   system: () => 'us' | 'metric' | 'native',
 *   timeZone: () => string | undefined,
 *   lowData: () => boolean,
 *   isOpened: (view: string) => boolean,
 *   state: () => import('../types.js').UrlState,
 *   writeState: (patch: import('../types.js').UrlState, opts?: { push?: boolean }) => void,
 * }} ViewContext
 */

/**
 * One panel's behavior. `load` returns the data and the status (null data renders the unavailable form);
 * `render` returns a cleanup function when it holds resources; `unavailable` replaces the default message.
 * @typedef {{
 *   load: (ctx: ViewContext, signal: AbortSignal) => Promise<{ data: unknown, status: StatusSnapshot }>,
 *   render: (body: HTMLElement, data: any, status: StatusSnapshot, ctx: ViewContext) => (() => void) | void,
 *   unavailable?: (body: HTMLElement, status: StatusSnapshot, ctx: ViewContext) => (() => void) | void,
 * }} ViewPanel
 */

/** @typedef {Record<string, ViewPanel>} ViewPanels */

export {};
