// @ts-check
/**
 * MP4 in video controls preload="none"; nothing autoplays (blueprint 7.3). Heavy: dynamic import() only. DOM module.
 *
 * Nothing loads until a tap. The start button prints the file size first. Once started, the native controls
 * stay on and a visible Pause button is always present (WCAG 2.2.2). `autoStart` is for a viewer that has
 * already had its own labeled tap; it never applies on page load.
 */
import { clear, h } from '../core/dom.js';
import { sizeLabel } from '../forecast/imagery.js';

/**
 * @param {HTMLElement} el
 * @param {{ src: string, label: string, bytes: number, autoStart?: boolean }} opts
 * @returns {{ destroy(): void }}
 */
export function createVideoPlayer(el, opts) {
  clear(el);
  el.classList.add('video-player');
  /** @type {HTMLVideoElement | null} */
  let video = null;
  let pause = /** @type {HTMLElement | null} */ (null);

  function start() {
    clear(el);
    video = /** @type {HTMLVideoElement} */ (h('video', { controls: true, preload: 'none', playsinline: true, muted: true, 'aria-label': opts.label, src: opts.src }));
    video.muted = true;
    pause = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'pause-video' }, 'Pause');
    const v = video;
    const p = pause;
    p.addEventListener('click', () => {
      if (v.paused) { void v.play().catch(() => {}); } else { v.pause(); }
    });
    v.addEventListener('play', () => { p.textContent = 'Pause'; });
    v.addEventListener('pause', () => { p.textContent = 'Play'; });
    v.addEventListener('error', () => {
      if (el.querySelector('[data-video-error]')) return;
      el.append(h('p', { class: 'video-player__size', 'data-video-error': '' }, 'The animation could not be loaded. ', h('a', { href: opts.src, rel: 'noopener' }, 'Open it at the source')));
    });
    el.append(v, p);
    void v.play().catch(() => { p.textContent = 'Play'; });
  }

  if (opts.autoStart) {
    start();
  } else {
    const startButton = h('button', { type: 'button', class: 'btn btn--secondary video-player__start', 'data-action': 'start-video' }, `Play Animation (${sizeLabel(opts.bytes)})`);
    startButton.addEventListener('click', start);
    el.append(startButton, h('span', { class: 'video-player__size' }, opts.label));
  }

  return {
    destroy() {
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      video = null;
      clear(el);
    },
  };
}
