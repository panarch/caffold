// The shadow roots of the Caffold components in the document. A query, an
// observer, or a capturing listener on the document does not reach inside
// them, so what has to see the whole page goes over the document and each of
// these roots. `CaffoldElement` adds its root when it connects and removes it
// when it disconnects.
const shadowRoots = new Set<ShadowRoot>();
const watchers = new Set<ShadowRootWatcher>();

type DocumentTree = Document | ShadowRoot;

interface ShadowRootWatcher {
  added(root: ShadowRoot): void;
  removed(root: ShadowRoot): void;
}

// The document and every shadow root in it, the document first.
export function documentTrees(): DocumentTree[] {
  return [document, ...shadowRoots];
}

// Runs `attach` on the document and on each shadow root, now and as roots
// join, and runs what it returned when a root leaves. The returned function
// undoes every attachment and stops following the roots.
export function eachDocumentTree(attach: (tree: DocumentTree) => () => void) {
  const detachers = new Map<DocumentTree, () => void>();
  for (const tree of documentTrees()) {
    detachers.set(tree, attach(tree));
  }
  const watcher: ShadowRootWatcher = {
    added: (root) => detachers.set(root, attach(root)),
    removed: (root) => {
      detachers.get(root)?.();
      detachers.delete(root);
    },
  };
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    for (const detach of detachers.values()) {
      detach();
    }
    detachers.clear();
  };
}

// Whether `node` is inside `ancestor`, a shadow root counting as inside its
// host. `Node.contains` stops at a shadow root.
export function containsAcrossShadowRoots(
  ancestor: Node,
  node: Node | null | undefined,
) {
  if (!node) {
    return false;
  }
  if (ancestor.contains(node)) {
    return true;
  }
  for (
    let root = node.getRootNode();
    root instanceof ShadowRoot;
    root = root.host.getRootNode()
  ) {
    if (ancestor.contains(root.host)) {
      return true;
    }
  }
  return false;
}

// Observes each of `roots` and, as they come and go, the shadow roots of the
// components inside them: a component changes inside its own root, which an
// observer of the root that holds it does not see. The returned function stops
// following new roots; disconnecting the observer ends the rest.
export function observeAcrossShadowRoots(
  observer: MutationObserver,
  roots: readonly Node[],
  options: MutationObserverInit,
) {
  for (const root of roots) {
    observer.observe(root, options);
  }
  return eachDocumentTree((tree) => {
    if (
      tree instanceof ShadowRoot &&
      !roots.includes(tree) &&
      roots.some((root) => containsAcrossShadowRoots(root, tree.host))
    ) {
      observer.observe(tree, options);
    }
    return () => {};
  });
}

// The nearest ancestor of `node` that matches `selector`, going on through the
// host of each shadow root it is in. `Element.closest` stops at a shadow root.
export function closestAcrossShadowRoots(
  node: Node | null | undefined,
  selector: string,
) {
  for (let current = node; current; ) {
    const match = current instanceof Element ? current.closest(selector) : null;
    if (match) {
      return match;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

// An element and the shadow root it renders into. An observer on the element
// alone does not see what changes inside that root.
export function elementAndShadowRoot(element: Element): Node[] {
  return element.shadowRoot ? [element, element.shadowRoot] : [element];
}

// The element that has focus, inside whatever shadow roots hold it.
// `document.activeElement` names only the outermost host.
export function focusedElement() {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) {
    focused = focused.shadowRoot.activeElement;
  }
  return focused;
}

export function addShadowRoot(root: ShadowRoot) {
  if (shadowRoots.has(root)) {
    return;
  }
  shadowRoots.add(root);
  for (const watcher of watchers) {
    watcher.added(root);
  }
}

export function removeShadowRoot(root: ShadowRoot) {
  if (!shadowRoots.delete(root)) {
    return;
  }
  for (const watcher of watchers) {
    watcher.removed(root);
  }
}
