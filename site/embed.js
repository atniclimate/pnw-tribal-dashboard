// @ts-check
// Host-page helper for Cascadia Tribal Hazard Dashboard iframes (blueprint 1.5). Optional: without it,
// the fixed height in the snippet applies. It resizes only iframe[data-cthd] elements whose own window
// sent the message, only for messages from the dashboard's origin with source 'cthd' and type 'resize',
// and clamps the height to 320 to 6000 px. An IIFE: it defines no globals and touches nothing else on
// the host page. Owner: lane L1.
(function () {
  var ORIGIN = 'https://atniclimate.github.io';
  addEventListener('message', function (event) {
    var d = event.data;
    if (event.origin !== ORIGIN || !d || d.source !== 'cthd' || d.type !== 'resize') return;
    var frames = document.querySelectorAll('iframe[data-cthd]');
    for (var i = 0; i < frames.length; i++) {
      var f = /** @type {HTMLIFrameElement} */ (frames[i]);
      if (f.contentWindow === event.source) {
        f.style.height = Math.min(Math.max(Math.round(Number(d.height) || 0), 320), 6000) + 'px';
      }
    }
  });
})();
