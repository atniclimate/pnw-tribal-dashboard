// @ts-check
/**
 * Entry module for the alerts page. Loaded by <script type="module">; its static imports are listed in the page's modulepreload block (check:preload). The page lane wires main() and calls it at the bottom of this module.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */
import { initChrome } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { loadAllAlerts } from '../alerts/service.js';
import { renderAlertList } from '../ui/alert-list.js';

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Page start-up. Not yet called: the page lane adds the call when it implements the page.
 * @returns {Promise<void>}
 */
export async function main() {
  void [initChrome, initEmbed, mountPanel, loadAllAlerts, renderAlertList];
  throw new Error(NOT_IMPLEMENTED);
}
