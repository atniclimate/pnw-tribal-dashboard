// @ts-check
/**
 * Image viewer with size-labeled taps and stamps (blueprint 7.3, 8.3). DOM module.
 *
 * Rules it enforces: an image loads without a tap only when its policy is auto, its size is 150 KB or less,
 * and low-data mode is off; every other image, larger swap, loop, and animation waits for a labeled tap that
 * prints its size first; a loop always has a visible Pause that swaps back to the still; reduced motion keeps
 * stills (loops are offered as a link to the source instead); an image with no stamp is never shown; every
 * image has width and height set before it loads.
 */
import { clear, h } from '../core/dom.js';
import { formatAsOf } from '../core/time.js';
import { imageDims, loadsWithoutTap, sizeLabel } from '../forecast/imagery.js';

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */

/**
 * @typedef {{
 *   product: ImageryProduct,
 *   stamp: string | null,
 *   timeZone: string,
 *   lowData: boolean,
 *   label?: string,
 *   stampText?: string | null,
 *   credit?: string | null,
 *   note?: string | null,
 *   forceTap?: boolean,
 *   catalog?: Map<string, ImageryProduct>,
 *   stamps?: Map<string, { lastModified: string | null }>,
 *   reducedMotion?: boolean,
 * }} ViewerOptions
 */

const reduced = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * @param {HTMLElement} el
 * @param {ViewerOptions} opts
 * @returns {{ setProduct(product: ImageryProduct, stamp: string | null, patch?: Partial<ViewerOptions>): void, destroy(): void }}
 */
export function createMediaViewer(el, opts) {
  /** @type {ViewerOptions} */
  let cfg = { ...opts };
  /** 'base' still, 'larger' still, or 'loop' (a GIF loop or an MP4). */
  let variant = /** @type {'base' | 'larger' | 'loop'} */ ('base');
  let requested = false;
  let failed = false;
  /** @type {{ destroy(): void } | null} */
  let video = null;
  let destroyed = false;

  const motionReduced = () => cfg.reducedMotion ?? reduced();
  const larger = () => (cfg.product.larger ? cfg.catalog?.get(cfg.product.larger) ?? null : null);
  const animation = () => (cfg.product.animation ? cfg.catalog?.get(cfg.product.animation) ?? null : null);
  const stampOf = () => cfg.stamp;
  const stampLine = () => {
    if (cfg.stampText) return cfg.stampText;
    const s = stampOf();
    return s ? `Image time ${formatAsOf(s, cfg.timeZone)}` : null;
  };

  function stopVideo() {
    video?.destroy();
    video = null;
  }

  /** @returns {ImageryProduct} the product whose still is currently shown */
  function shownProduct() {
    if (variant === 'larger') return larger() ?? cfg.product;
    return cfg.product;
  }

  /** @param {ImageryProduct} p */
  function altText(p) {
    const base = cfg.label ?? p.title ?? p.id;
    const line = stampLine();
    return line ? `${base}. ${line}.` : `${base}.`;
  }

  /** @param {string} text @param {() => void} fn @param {string} [action] */
  function button(text, fn, action) {
    const b = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': action ?? null }, text);
    b.addEventListener('click', fn);
    return b;
  }

  function render() {
    if (destroyed) return;
    stopVideo();
    clear(el);
    el.classList.add('media-viewer');
    const line = stampLine();
    const stage = h('div', { class: 'media-viewer__stage' });
    const controls = h('div', { class: 'media-viewer__controls' });
    const caption = h('figcaption', { class: 'media-viewer__caption' });
    const p = cfg.product;
    const sourceLink = h('a', { href: p.url, rel: 'noopener' }, 'Open at the source');

    if (!line) {
      stage.append(h('p', { class: 'media-viewer__notice' }, 'This image has no published time, so it is not shown. ', sourceLink));
    } else if (p.loadPolicy === 'link') {
      stage.append(h('p', { class: 'media-viewer__notice' }, 'This image opens at its source. ', sourceLink));
    } else {
      const auto = !cfg.forceTap && !cfg.lowData && loadsWithoutTap(p);
      const show = variant !== 'base' || auto || requested;
      const anim = animation();
      if (!show) {
        stage.append(h('p', { class: 'media-viewer__notice' }, cfg.lowData ? 'Low-data mode is on. Images load when you tap.' : 'This image loads when you tap.'));
        controls.append(button(`Load Image (${sizeLabel(p.typicalBytes)})`, () => { requested = true; render(); }, 'load-image'));
      } else if (failed) {
        stage.append(h('p', { class: 'media-viewer__notice' }, 'The image could not be loaded. ', sourceLink));
      } else if (variant === 'loop' && anim?.kind === 'video') {
        stage.append(h('p', { class: 'media-viewer__notice' }, 'Loading animation'));
      } else if (variant === 'loop' && anim?.kind === 'loop-gif') {
        const d = imageDims(anim);
        stage.append(h('img', { src: anim.url, alt: `${altText(p)} Animated loop.`, width: d.width, height: d.height, decoding: 'async', 'data-image-id': anim.id }));
      } else if (variant === 'loop' && cfg.product.kind === 'loop-gif') {
        const d = imageDims(cfg.product);
        stage.append(h('img', { src: cfg.product.url, alt: `${altText(p)} Animated loop.`, width: d.width, height: d.height, decoding: 'async', 'data-image-id': cfg.product.id }));
      } else {
        const shownStill = shownProduct();
        const stillUrl = cfg.product.kind === 'loop-gif' ? (cfg.product.still ?? cfg.product.url) : shownStill.url;
        const d = imageDims(shownStill);
        const img = h('img', { src: stillUrl, alt: altText(p), width: d.width, height: d.height, loading: 'lazy', decoding: 'async', 'data-image-id': shownStill.id });
        img.addEventListener('error', () => { failed = true; render(); }, { once: true });
        stage.append(img);
      }

      if (show && !failed) {
        const big = larger();
        if (big && variant === 'base') controls.append(button(`Larger Image (${sizeLabel(big.typicalBytes)})`, () => { variant = 'larger'; render(); }, 'larger-image'));
        if (big && variant === 'larger') controls.append(button('Smaller Image', () => { variant = 'base'; render(); }, 'smaller-image'));
        if (anim && anim.kind === 'video' && variant !== 'loop') {
          controls.append(button(`Play Animation (${sizeLabel(anim.typicalBytes)})`, async () => {
            variant = 'loop';
            render();
          }, 'play-animation'));
        }
        if (anim && anim.kind === 'loop-gif' && variant !== 'loop') {
          if (motionReduced()) controls.append(h('a', { class: 'btn btn--link', href: anim.url, rel: 'noopener' }, `Open Loop at the Source (${sizeLabel(anim.typicalBytes)})`));
          else controls.append(button(`Play Loop (${sizeLabel(anim.typicalBytes)})`, () => { variant = 'loop'; render(); }, 'play-loop'));
        }
        if (cfg.product.kind === 'loop-gif' && variant !== 'loop') {
          if (motionReduced()) controls.append(h('a', { class: 'btn btn--link', href: cfg.product.url, rel: 'noopener' }, `Open Loop at the Source (${sizeLabel(cfg.product.typicalBytes)})`));
          else controls.append(button(`Play Loop (${sizeLabel(cfg.product.typicalBytes)})`, () => { variant = 'loop'; render(); }, 'play-loop'));
        }
        if (variant === 'loop' && anim?.kind !== 'video') controls.append(button('Pause', () => { variant = 'base'; render(); }, 'pause-loop'));
        if (variant === 'loop' && anim?.kind === 'video') {
          controls.append(button('Show Still Image', () => { variant = 'base'; render(); }, 'show-still'));
        }
      }
    }

    caption.append(cfg.label ?? p.title ?? p.id);
    if (line) {
      const s = stampOf();
      caption.append(' ', h('span', { class: 'stamp' }, s && !cfg.stampText ? ['Image time ', h('time', { datetime: s }, formatAsOf(s, cfg.timeZone))] : line));
    }
    if (cfg.credit) caption.append(' ', h('span', {}, cfg.credit));
    if (cfg.note) caption.append(' ', h('span', {}, cfg.note));

    el.append(h('figure', { class: 'media-viewer__figure', 'data-product': p.id }, stage, controls, caption));

    // The MP4 is mounted after the figure exists, through a dynamic import so the player never loads on first paint.
    const anim = animation();
    if (variant === 'loop' && anim?.kind === 'video') {
      const container = /** @type {HTMLElement} */ (stage);
      clear(container);
      void import('./video-player.js').then(({ createVideoPlayer }) => {
        if (destroyed || variant !== 'loop' || !container.isConnected) return;
        video = createVideoPlayer(container, { src: anim.url, label: altText(p), bytes: anim.typicalBytes, autoStart: true });
      });
    }
  }

  render();

  return {
    setProduct(product, stamp, patch = {}) {
      stopVideo();
      cfg = { ...cfg, ...patch, product, stamp };
      variant = 'base';
      requested = false;
      failed = false;
      render();
    },
    destroy() {
      destroyed = true;
      stopVideo();
      clear(el);
    },
  };
}
