// @ts-check
// Classic, render-blocking script (blueprint 1.4). Sets embed, framed, low-data, and single-panel flags on
// <html> before first paint so chrome never flashes inside an iframe. An IIFE: it defines no globals.
// Owner: lane L0 (complete).
(function () {
  var root = document.documentElement;
  var p = new URLSearchParams(location.search);
  var e = p.get('embed');
  var framed;
  try { framed = window.self !== window.top; } catch (_) { framed = true; }
  if (e === '1' || e === 'true' || (framed && e !== '0' && e !== 'false')) root.setAttribute('data-embed', '1');
  if (framed) root.setAttribute('data-framed', '1');
  var low = p.get('lowdata') === '1';
  try { low = low || localStorage.getItem('cthd:v1:lowdata') === '1'; } catch (_) { /* storage blocked */ }
  var c = /** @type {any} */ (navigator).connection;
  if (low || (c && c.saveData)) root.setAttribute('data-lowdata', '1');
  var panel = p.get('panel');
  if (panel && /^[a-z-]{1,24}$/.test(panel)) root.setAttribute('data-panel-only', panel);
})();
