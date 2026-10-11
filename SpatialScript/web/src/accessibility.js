// AccessibilityComponent mirrored to the DOM (SPEC 14.11). Each object with an
// accessibility payload gets an offscreen element carrying the aria attributes,
// so a screen reader and an automated check can both see it.

export class AccessibilityMirror {
  constructor(document_) {
    this.document = document_ || (typeof document !== 'undefined' ? document : null);
    /** @type {Map<number, {element: Element, spec: object}>} */
    this.entries = new Map();
    this.container = null;
  }

  _ensureContainer() {
    if (this.container || !this.document) return this.container;
    const container = this.document.createElement('div');
    // A fixed id would collide if two consumers shared a page (P2-B-49).
    container.className = 'spatial-accessibility';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Scene contents');
    // Offscreen rather than display:none, so assistive technology still reads it.
    container.style.cssText = 'position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
    (this.document.body || this.document.documentElement).appendChild(container);
    this.container = container;
    return container;
  }

  /** `accessibility`: the payload, or null to remove the element. */
  set(id, name, spec) {
    if (!spec) {
      this.remove(id);
      return;
    }
    let entry = this.entries.get(id);
    if (!entry) {
      const container = this._ensureContainer();
      const element = container ? this.document.createElement(spec.isButton ? 'button' : 'div') : null;
      if (element) {
        element.dataset.spatialId = String(id);
        container.appendChild(element);
      }
      entry = { element, spec };
      this.entries.set(id, entry);
    } else if (entry.element && (entry.spec.isButton === true) !== (spec.isButton === true)) {
      // A role change needs a different element.
      const replacement = this.document.createElement(spec.isButton ? 'button' : 'div');
      replacement.dataset.spatialId = String(id);
      entry.element.replaceWith(replacement);
      entry.element = replacement;
    }
    entry.spec = spec;

    const { element } = entry;
    if (!element) return;
    if (spec.label !== undefined && spec.label !== null) element.setAttribute('aria-label', String(spec.label));
    else element.removeAttribute('aria-label');
    if (spec.value !== undefined && spec.value !== null) element.setAttribute('aria-valuetext', String(spec.value));
    else element.removeAttribute('aria-valuetext');
    if (spec.hint !== undefined && spec.hint !== null) element.setAttribute('aria-description', String(spec.hint));
    else element.removeAttribute('aria-description');
    if (!spec.isButton) element.setAttribute('role', 'img');
    element.textContent = spec.label ? String(spec.label) : (name || '');
  }

  describe(id) {
    const entry = this.entries.get(id);
    return entry ? { ...entry.spec } : null;
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.element) entry.element.remove();
  }

  reset() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  /** P2-B-49: the container must not outlive the consumer that made it. */
  dispose() {
    this.reset();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
