// @ts-check
/**
 * WebGL2 capability probe before any library request (blueprint 4.6). DOM module.
 *
 * Owner: lane L8.
 */

/** @typedef {import('../types.js').MapSupport} MapSupport */

/**
 * @param {any} gl
 * @returns {void}
 */
function release(gl) {
  try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* the context is already gone */ }
}

/**
 * 1 x 1 canvas, webgl2 with failIfMajorPerformanceCaveat, released at once: 'full' (hardware WebGL2),
 * 'caveat' (WebGL2 only through software rendering), or 'none'.
 * @param {() => HTMLCanvasElement} [makeCanvas] injectable for tests
 * @returns {MapSupport}
 */
export function probeWebGL(makeCanvas = () => document.createElement('canvas')) {
  try {
    const hardware = makeCanvas();
    hardware.width = 1;
    hardware.height = 1;
    const gl = hardware.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (gl) { release(gl); return 'full'; }
    const soft = makeCanvas();
    soft.width = 1;
    soft.height = 1;
    const slow = soft.getContext('webgl2');
    if (slow) { release(slow); return 'caveat'; }
  } catch { /* a throwing probe means no usable WebGL */ }
  return 'none';
}

/**
 * `requested` means the viewer asked for the interactive map explicitly ("Load Interactive Map"); it never
 * overrides `none`.
 * @param {MapSupport} support
 * @param {{ lowData: boolean, requested: boolean }} opts
 * @returns {'interactive' | 'outline' | 'outline-offer-interactive'}
 */
export function chooseMode(support, opts) {
  if (support === 'none') return 'outline';
  if (opts.requested) return 'interactive';
  if (support === 'caveat' || opts.lowData) return 'outline-offer-interactive';
  return 'interactive';
}
