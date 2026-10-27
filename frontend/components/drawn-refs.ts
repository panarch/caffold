import { type ElementPart, nothing } from "lit";
import {
  Directive,
  directive,
  type PartInfo,
  PartType,
} from "lit/async-directive.js";

const drawnElements = new WeakMap<DrawnRef<Element>, Element>();

/**
 * The element one place in its owner's template draws.
 *
 * Lit's `ref` empties while the owner is out of the document, but an owner
 * drawn before it is attached, or still tidying up as it leaves, needs its
 * elements then. This one answers while the element is still inside its
 * owner or the owner's shadow root, wherever the owner is.
 */
export class DrawnRef<T extends Element> {
  private readonly owner: Element;

  constructor(owner: Element) {
    this.owner = owner;
  }

  get value(): T | undefined {
    const element = drawnElements.get(this);
    const inside =
      element &&
      (this.owner.contains(element) ||
        this.owner.shadowRoot?.contains(element));
    return inside ? (element as T) : undefined;
  }
}

// One `DrawnRef` per key, so each item of a keyed list keeps its element.
export class DrawnRefs<T extends Element> {
  private readonly owner: Element;
  private readonly refs = new Map<string, DrawnRef<T>>();

  constructor(owner: Element) {
    this.owner = owner;
  }

  of(key: string) {
    let found = this.refs.get(key);
    if (!found) {
      found = new DrawnRef<T>(this.owner);
      this.refs.set(key, found);
    }
    return found;
  }

  get(key: string) {
    return this.refs.get(key)?.value;
  }
}

class DrawnDirective extends Directive {
  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ELEMENT) {
      throw new Error("`drawn` goes on an element.");
    }
  }

  render(_ref: DrawnRef<Element>) {
    return nothing;
  }

  override update(part: ElementPart, [ref]: [DrawnRef<Element>]) {
    drawnElements.set(ref, part.element);
    return nothing;
  }
}

// Points `ref` at the element this sits on.
export const drawn = directive(DrawnDirective);
