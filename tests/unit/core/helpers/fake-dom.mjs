// @ts-check
/**
 * A minimal DOM for Node unit tests of the DOM modules (dom, provenance, panel, poller, url-state). It
 * implements only what those modules touch: elements, text, attributes, dataset, simple selectors,
 * bubbling events, and document visibility. Real-browser behavior is covered by tests/e2e/harness.spec.mjs.
 */

export class FakeEvent {
  /** @param {string} type */
  constructor(type) {
    this.type = type;
    /** @type {any} */
    this.target = null;
    this.bubbles = true;
  }
}

export class FakeNode {
  constructor() {
    /** @type {FakeNode | null} */
    this.parentNode = null;
    /** @type {FakeNode[]} */
    this.childNodes = [];
    /** @type {Map<string, Set<(e: FakeEvent) => void>>} */
    this.listeners = new Map();
  }

  /** @returns {FakeNode | null} */
  get firstChild() { return this.childNodes[0] ?? null; }

  /** @param {FakeNode} n */
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }

  /** @param {FakeNode} n */
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }

  /**
   * @param {FakeNode} n
   * @param {FakeNode | null} ref
   */
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }

  /** @param {...(FakeNode | string)} nodes */
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }

  /** @param {...(FakeNode | string)} nodes */
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }

  /** @param {FakeNode} n */
  contains(n) {
    /** @type {FakeNode | null} */
    let x = n;
    for (; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  /** @returns {string} */
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }

  /**
   * @param {string} type
   * @param {(e: FakeEvent) => void} fn
   */
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  /**
   * @param {string} type
   * @param {(e: FakeEvent) => void} fn
   */
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }

  /** @param {FakeEvent} e */
  dispatchEvent(e) {
    if (!e.target) e.target = this;
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
    if (e.bubbles && this.parentNode) this.parentNode.dispatchEvent(e);
    return true;
  }
}

export class FakeText extends FakeNode {
  /** @param {string} text */
  constructor(text) { super(); this.nodeType = 3; this.data = text; }

  get textContent() { return this.data; }
}

/** @param {string} s */
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeElement extends FakeNode {
  /**
   * @param {string} tag
   * @param {string} [ns]
   */
  constructor(tag, ns = 'http://www.w3.org/1999/xhtml') {
    super();
    this.nodeType = 1;
    this.tagName = tag.toLowerCase();
    this.namespaceURI = ns;
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    const el = this;
    /** @type {Record<string, string>} */
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.attrs.get(`data-${kebab(k)}`) : undefined),
      set: (_t, k, v) => { el.attrs.set(`data-${kebab(String(k))}`, String(v)); return true; },
      has: (_t, k) => el.attrs.has(`data-${kebab(String(k))}`),
    });
  }

  /** @param {string} k @param {string} v */
  setAttribute(k, v) { this.attrs.set(k, String(v)); }

  /** @param {string} k */
  getAttribute(k) { return this.attrs.get(k) ?? null; }

  /** @param {string} k */
  hasAttribute(k) { return this.attrs.has(k); }

  /** @param {string} k */
  removeAttribute(k) { this.attrs.delete(k); }

  get className() { return this.attrs.get('class') ?? ''; }

  /** @param {string} sel */
  matches(sel) {
    const m = /^(?:([a-z0-9-]+))?(?:\.([\w-]+))?(?:\[([\w:-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i.exec(sel);
    if (!m) throw new Error(`fake-dom: unsupported selector ${sel}`);
    const [, tag, cls, attr, val] = m;
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    if (cls && !this.className.split(/\s+/).includes(cls)) return false;
    if (attr) {
      if (!this.attrs.has(attr)) return false;
      if (val !== undefined && this.attrs.get(attr) !== val) return false;
    }
    return true;
  }

  /** @param {string} sel */
  closest(sel) {
    /** @type {FakeNode | null} */
    let n = this;
    for (; n; n = n.parentNode) if (n instanceof FakeElement && n.matches(sel)) return n;
    return null;
  }

  /** @param {string} sel @returns {FakeElement[]} */
  querySelectorAll(sel) {
    /** @type {FakeElement[]} */
    const out = [];
    const walk = (/** @type {FakeNode} */ n) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) { if (c.matches(sel)) out.push(c); walk(c); }
      }
    };
    walk(this);
    return out;
  }

  /** @param {string} sel */
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

/**
 * Installs the fake document and node globals. Returns the document and a restore function.
 * @returns {{ document: any, restore: () => void }}
 */
export function installFakeDom() {
  const g = /** @type {any} */ (globalThis);
  const saved = { document: g.document, Element: g.Element, Node: g.Node };
  const root = new FakeElement('html');
  const doc = Object.assign(new FakeNode(), {
    hidden: false,
    documentElement: root,
    /** @param {string} t */
    createElement: (t) => new FakeElement(t),
    /** @param {string} ns @param {string} t */
    createElementNS: (ns, t) => new FakeElement(t, ns),
    /** @param {string} t */
    createTextNode: (t) => new FakeText(t),
  });
  g.document = doc;
  g.Element = FakeElement;
  g.Node = FakeNode;
  return {
    document: doc,
    restore() { g.document = saved.document; g.Element = saved.Element; g.Node = saved.Node; },
  };
}
