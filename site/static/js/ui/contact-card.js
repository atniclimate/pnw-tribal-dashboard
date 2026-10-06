// @ts-check
/** Escaped contact cards with source, verified date, and Verification Due tags. Federal-directory fallbacks remain explicitly labeled; overdue lines remain visible with their status. */
import { h, telHref } from '../core/dom.js';
import { CONTACT_EMAIL } from '../config/pages.js';
import { LINE_TYPE_LABELS, formatDay, isVerificationDue } from '../data/contacts.js';
import { statusPill } from './status-pill.js';

/** @typedef {import('../types.js').Contact} Contact */

const METHOD_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  'page-text-match': 'matched to the published page',
  'official-pdf': 'matched to an official document',
  'phone-confirmed': 'confirmed by phone',
  'nation-confirmed': 'confirmed by the Nation',
  'federal-directory': 'read from the federal directory',
}));

/**
 * A link to another site, marked to open in a new tab with rel="noopener" at creation (core/embed.js only
 * marks links that exist when it starts or that are clicked).
 * @param {string} href
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function outwardLink(href, ...children) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...children);
}

/**
 * Marks every link to another site under `root`, now and as panels add them (provenance footers are written
 * after a load), to open in a new tab with rel="noopener".
 * @param {ParentNode} root
 * @returns {() => void} stop watching
 */
export function markOutwardLinks(root) {
  /** @param {ParentNode} scope */
  const mark = (scope) => {
    for (const a of scope.querySelectorAll('a[href]')) {
      if (!(a instanceof HTMLAnchorElement) || a.target === '_blank') continue;
      let outward = false;
      try { outward = /^https?:$/.test(a.protocol) && a.origin !== location.origin; } catch { /* unparsable href */ }
      if (outward) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
  };
  mark(root);
  const observer = new MutationObserver(() => mark(root));
  observer.observe(root instanceof Node ? root : document, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * The correction request link: the maintainer's contact route (the public repository has no issue forms).
 * @param {Contact} contact
 * @returns {string}
 */
export function correctionHref(contact) {
  const subject = `Contact correction: ${contact.id}`;
  const body = [
    `Contact id: ${contact.id}`,
    `Organization: ${contact.org}`,
    contact.office ? `Office: ${contact.office}` : null,
    '',
    'What should change, and where the correct information is published:',
    '',
  ].filter((l) => l !== null).join('\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * @param {Contact} contact
 * @param {{ now: Date, emergency?: boolean }} opts
 * @returns {HTMLElement}
 */
export function contactCard(contact, opts) {
  const due = isVerificationDue(contact, opts.now);
  const federal = contact.source.kind === 'federal-directory';
  const phoneHref = contact.phone ? telHref(contact.phone.e164) : '';
  const verified = formatDay(contact.verification.verifiedAt);
  const method = METHOD_LABELS[contact.verification.method] ?? contact.verification.method;
  const classes = ['contact-card'];
  if (federal) classes.push('contact-card--fallback');
  if (opts.emergency) classes.push('contact-card--emergency');

  const sourceLine = federal
    ? h('p', { class: 'contact-card__verified' }, 'Listed by ', outwardLink(contact.source.url, contact.source.publisher), `, checked ${verified}.`)
    : h('p', { class: 'contact-card__verified' }, `Verified ${verified}, ${method}. Source: `, outwardLink(contact.source.url, contact.source.publisher), '.');

  return h('article', { class: classes.join(' '), 'data-contact-id': contact.id, 'data-verification-due': due ? 'true' : null },
    h('h3', { class: 'contact-card__name' }, contact.org),
    contact.office ? h('p', { class: 'contact-card__role' }, contact.office) : null,
    h('span', { class: 'contact-card__line-type' }, LINE_TYPE_LABELS[contact.lineType] ?? contact.lineType),
    contact.phone && phoneHref
      ? h('a', { class: 'contact-card__phone', href: phoneHref }, contact.phone.display)
      : null,
    contact.phone?.ext ? h('span', { class: 'caption' }, `Extension ${contact.phone.ext}`) : null,
    contact.email ? h('p', { class: 'caption' }, 'Email ', h('a', { href: `mailto:${contact.email}` }, contact.email)) : null,
    contact.url ? h('p', { class: 'caption' }, 'Website ', outwardLink(contact.url, hostOf(contact.url))) : null,
    contact.hours ? h('p', { class: 'caption' }, `Hours: ${contact.hours}`) : null,
    sourceLine,
    due ? statusPill('stale', 'Verification Due') : null,
    h('a', { class: 'btn btn--link', href: correctionHref(contact) }, 'Report a Correction'),
  );
}
