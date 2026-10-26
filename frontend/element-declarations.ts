import { type ElementPart, nothing } from "lit";
import {
  AsyncDirective,
  directive,
  type PartInfo,
  PartType,
} from "lit/async-directive.js";

export interface DeclaredElement<Value> {
  element: Element;
  value: Value;
}

// Elements that hold a keyboard context of their own, a modal or a popover.
// A declaration belongs to the nearest one around it, wherever its owner is.
const contextRoots = new WeakSet<Element>();

/**
 * Values one component's template declares on its elements.
 *
 * A value stays while its element is drawn and leaves with it, so reading
 * the list never finds an element the template no longer draws.
 */
export class ElementDeclarations<Value> {
  private readonly owner: Element;
  private readonly marksContextRoots: boolean;
  private readonly entries = new Map<object, DeclaredElement<Value>>();

  constructor(owner: Element, { contextRoots = false } = {}) {
    this.owner = owner;
    this.marksContextRoots = contextRoots;
  }

  on(value: Value) {
    return declaration(this as ElementDeclarations<unknown>, value);
  }

  // The declarations in document order that belong to `contextRoot`, null
  // for none. Left out, the context the owner itself is in.
  list(contextRoot?: Element | null) {
    const wanted =
      contextRoot === undefined ? contextRootOf(this.owner) : contextRoot;
    return this.all().filter(
      (entry) => contextRootOf(entry.element) === wanted,
    );
  }

  // Every declaration in document order.
  all() {
    return [...this.entries.values()].sort((left, right) =>
      documentOrder(left.element, right.element),
    );
  }

  add(key: object, entry: DeclaredElement<Value>) {
    if (this.marksContextRoots) {
      contextRoots.add(entry.element);
    }
    this.entries.set(key, entry);
  }

  remove(key: object) {
    this.entries.delete(key);
  }
}

function contextRootOf(element: Element) {
  for (let node = parentOf(element); node; node = parentOf(node)) {
    if (contextRoots.has(node)) {
      return node;
    }
  }
  return null;
}

// What an element sits in, past a shadow root to its host.
function parentOf(element: Element) {
  return (
    element.parentElement ??
    (element.getRootNode?.() as ShadowRoot | undefined)?.host ??
    null
  );
}

function documentOrder(left: Element, right: Element) {
  if (left === right) {
    return 0;
  }
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING
    ? 1
    : -1;
}

class DeclarationDirective extends AsyncDirective {
  private declarations: ElementDeclarations<unknown> | null = null;
  private entry: DeclaredElement<unknown> | null = null;

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ELEMENT) {
      throw new Error("A declaration goes on an element.");
    }
  }

  render(_declarations: ElementDeclarations<unknown>, _value: unknown) {
    return nothing;
  }

  update(
    part: ElementPart,
    [declarations, value]: Parameters<DeclarationDirective["render"]>,
  ) {
    if (this.declarations !== declarations) {
      this.declarations?.remove(this);
      this.declarations = declarations;
    }
    this.entry = { element: part.element, value };
    if (this.isConnected) {
      declarations.add(this, this.entry);
    }
    return nothing;
  }

  protected disconnected() {
    this.declarations?.remove(this);
  }

  protected reconnected() {
    if (this.declarations && this.entry) {
      this.declarations.add(this, this.entry);
    }
  }
}

const declaration = directive(DeclarationDirective);
