import { mergeActionHintScopes } from "./action-hints.js";
import { mergeScrollSurfaceScopes } from "./scroll-scope.js";

const KEYBOARD_CONTEXT_KINDS = new Set(["workspace", "modal", "popover"]);

export function keyboardNavigationContext({
  id,
  kind,
  root,
  actionHints = null,
  scroll = null,
  editing = null,
} = {}) {
  const context = { id, kind, root };
  if (actionHints != null) {
    if (typeof actionHints !== "object") {
      throw new TypeError("Action Hint capability must be an object");
    }
    context.actionHints = {
      dialog: actionHints.dialog,
      scope: mergeActionHintScopes(actionHints.scope),
    };
  }
  if (scroll != null) {
    if (typeof scroll !== "object") {
      throw new TypeError("Scroll capability must be an object");
    }
    context.scroll = {
      hud: scroll.hud,
      scope: mergeScrollSurfaceScopes(scroll.scope),
    };
  }
  if (editing != null) {
    if (typeof editing !== "object") {
      throw new TypeError("Editing capability must be an object");
    }
    context.editing = {
      escapeTarget: editing.escapeTarget,
    };
  }
  return context;
}

export function mergeKeyboardNavigationContexts(...collections) {
  const contexts = [];
  for (const collection of collections) {
    if (collection == null) {
      continue;
    }
    if (!Array.isArray(collection)) {
      throw new TypeError("Keyboard navigation context collection must be an array");
    }
    contexts.push(...collection);
  }
  return contexts;
}

export function normalizeKeyboardNavigationContexts(contexts) {
  if (!Array.isArray(contexts)) {
    return null;
  }
  const ids = new Set();
  const roots = new Set();
  const normalized = [];
  for (const context of contexts) {
    const id = `${context?.id ?? ""}`.trim();
    const kind = `${context?.kind ?? ""}`;
    const root = context?.root;
    if (
      !id ||
      ids.has(id) ||
      !KEYBOARD_CONTEXT_KINDS.has(kind) ||
      !(root instanceof HTMLElement) ||
      roots.has(root)
    ) {
      return null;
    }
    const actionHints = context.actionHints == null
      ? null
      : normalizeActionHintCapability(context.actionHints, root);
    const scroll = context.scroll == null
      ? null
      : normalizeScrollCapability(context.scroll, root);
    const editing = context.editing == null
      ? null
      : normalizeEditingCapability(context.editing);
    if (
      (context.actionHints != null && !actionHints) ||
      (context.scroll != null && !scroll) ||
      (context.editing != null && !editing) ||
      (!actionHints && !scroll && !editing)
    ) {
      return null;
    }
    ids.add(id);
    roots.add(root);
    normalized.push({ id, kind, root, actionHints, scroll, editing });
  }
  return normalized;
}

function normalizeEditingCapability(capability) {
  return typeof capability?.escapeTarget === "function"
    ? { escapeTarget: capability.escapeTarget }
    : null;
}

export function popoverScrollSurfaceScope({
  id,
  label,
  popover,
  isCurrent = () => true,
} = {}) {
  return {
    blocked: false,
    surfaces: [{
      id,
      label,
      scrollport: popover,
      clipRoots: [popover],
      isEligible: () => {
        try {
          return Boolean(
            popover?.isConnected &&
              popover.matches(":popover-open") &&
              isCurrent(),
          );
        } catch {
          return false;
        }
      },
    }],
    mutationRoots: [popover],
    resizeElements: [popover],
    scrollRoots: [popover],
  };
}

function normalizeActionHintCapability(capability, root) {
  const dialog = capability?.dialog;
  const scope = capability?.scope;
  if (
    !(dialog instanceof HTMLElement) ||
    !root.contains(dialog) ||
    typeof dialog.open !== "function" ||
    typeof dialog.close !== "function" ||
    typeof dialog.allowsNativeActivation !== "function" ||
    typeof dialog.ownsModal !== "function" ||
    typeof dialog.updateInput !== "function" ||
    typeof dialog.updateTargetLabels !== "function" ||
    !scope ||
    typeof scope !== "object" ||
    !Array.isArray(scope.targets)
  ) {
    return null;
  }
  const mutationRoots = normalizeElementList(scope.mutationRoots ?? []);
  const scrollRoots = normalizeElementList(scope.scrollRoots ?? []);
  if (!mutationRoots || !scrollRoots) {
    return null;
  }
  return {
    dialog,
    scope: {
      blocked: Boolean(scope.blocked),
      targets: [...scope.targets],
      mutationRoots,
      scrollRoots,
    },
  };
}

function normalizeScrollCapability(capability, root) {
  const hud = capability?.hud;
  const scope = capability?.scope;
  if (
    !(hud instanceof HTMLElement) ||
    !root.contains(hud) ||
    typeof hud.show !== "function" ||
    typeof hud.close !== "function" ||
    typeof hud.updateLabel !== "function" ||
    !scope ||
    typeof scope !== "object" ||
    !Array.isArray(scope.surfaces)
  ) {
    return null;
  }
  const mutationRoots = normalizeElementList([
    root,
    ...(scope.mutationRoots ?? []),
  ]);
  const resizeElements = normalizeElementList([
    root,
    ...(scope.resizeElements ?? []),
  ]);
  const scrollRoots = normalizeElementList(scope.scrollRoots ?? []);
  const surfaces = normalizeSurfaces(scope.surfaces);
  if (!mutationRoots || !resizeElements || !scrollRoots || !surfaces) {
    return null;
  }
  return {
    hud,
    scope: {
      blocked: Boolean(scope.blocked),
      surfaces,
      mutationRoots,
      resizeElements,
      scrollRoots,
    },
  };
}

function normalizeSurfaces(surfaces) {
  const ids = new Set();
  const normalized = [];
  for (const surface of surfaces) {
    const id = `${surface?.id ?? ""}`.trim();
    const label = `${surface?.label ?? ""}`.trim();
    const clipRoots = normalizeElementList(surface?.clipRoots ?? []);
    if (
      !id ||
      ids.has(id) ||
      !label ||
      !(surface?.scrollport instanceof HTMLElement) ||
      !clipRoots ||
      typeof surface?.isEligible !== "function"
    ) {
      return null;
    }
    ids.add(id);
    normalized.push({ ...surface, id, label, clipRoots });
  }
  return normalized;
}

function normalizeElementList(elements) {
  if (
    !Array.isArray(elements) ||
    elements.some(
      (element) =>
        !(element instanceof Element) ||
        typeof element.getBoundingClientRect !== "function",
    )
  ) {
    return null;
  }
  return uniqueElements(elements);
}

function uniqueElements(elements) {
  const unique = [];
  const seen = new Set();
  for (const element of elements) {
    if (!seen.has(element)) {
      seen.add(element);
      unique.push(element);
    }
  }
  return unique;
}
