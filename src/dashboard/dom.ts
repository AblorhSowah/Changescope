/** DOM helpers. Text only ever goes in through textContent, attributes through setAttribute of known names. */

export type Attrs = Readonly<Record<string, string>>;

export function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls = '', attrs: Attrs = {}, text = ''): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (cls !== '') el.className = cls;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  if (text !== '') el.textContent = text;
  return el;
}

export function button(doc: Document, cls: string, attrs: Attrs = {}, text = ''): HTMLButtonElement {
  return h(doc, 'button', cls, { type: 'button', ...attrs }, text);
}

/** The setters below write only on change, so an unchanged state causes no DOM writes (and no restarted animation). */
export function setText(el: Element, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function setClass(el: Element, value: string): void {
  if (el.className !== value) el.className = value;
}

/** CSS custom properties go through the CSSOM: a style attribute would be blocked by the webview CSP. */
export function setVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

export function setDisabled(el: HTMLButtonElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

export type Child = Element | false | null | undefined;

/**
 * Makes `wanted` (falsy entries skipped) the exact children of `parent`, in order. A node is moved only
 * when it is out of place, because moving a node restarts its CSS animation and drops its focus.
 */
export function placeChildren(parent: Element, wanted: readonly Child[]): void {
  const list: Element[] = [];
  for (const c of wanted) if (c) list.push(c);
  const keep = new Set<Element>(list);
  let child = parent.firstElementChild;
  while (child) {
    const next = child.nextElementSibling;
    if (!keep.has(child)) child.remove();
    child = next;
  }
  let ref = parent.firstElementChild;
  for (const el of list) {
    if (ref === el) ref = ref.nextElementSibling;
    else parent.insertBefore(el, ref);
  }
}

export interface Slot {
  readonly el: HTMLElement;
}

/**
 * Keyed list: one slot per key, created once, updated in place, removed when its key is gone.
 * A repeated key keeps its first item.
 */
export function syncList<T, S extends Slot>(
  parent: Element,
  items: readonly T[],
  slots: Map<string, S>,
  keyOf: (item: T) => string,
  create: (item: T) => S,
  update: (slot: S, item: T) => void,
): void {
  const wanted: Element[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    let slot = slots.get(key);
    if (!slot) {
      slot = create(item);
      slots.set(key, slot);
    }
    update(slot, item);
    wanted.push(slot.el);
  }
  for (const [key, slot] of slots) {
    if (seen.has(key)) continue;
    slot.el.remove();
    slots.delete(key);
  }
  placeChildren(parent, wanted);
}

export function isElement(x: EventTarget | null): x is Element {
  return x !== null && 'closest' in x && typeof x.closest === 'function';
}

/** Focus without relying on `instanceof` (the document may belong to another realm, as in jsdom). */
export function focusEl(x: Element | null | undefined): void {
  if (x && 'focus' in x && typeof x.focus === 'function') x.focus();
}
