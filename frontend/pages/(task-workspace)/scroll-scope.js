const SCROLL_SCOPE_LIST_KEYS = [
  "surfaces",
  "mutationRoots",
  "resizeElements",
  "scrollRoots",
];

export function emptyScrollSurfaceScope() {
  return {
    blocked: false,
    surfaces: [],
    mutationRoots: [],
    resizeElements: [],
    scrollRoots: [],
  };
}

export function mergeScrollSurfaceScopes(...scopes) {
  const merged = emptyScrollSurfaceScope();
  for (const scope of scopes) {
    if (scope == null) {
      continue;
    }
    if (typeof scope !== "object") {
      throw new TypeError("Scroll surface scope must be an object");
    }
    merged.blocked ||= Boolean(scope.blocked);
    for (const key of SCROLL_SCOPE_LIST_KEYS) {
      const items = scope[key];
      if (items == null) {
        continue;
      }
      if (!Array.isArray(items)) {
        throw new TypeError(`Scroll surface scope ${key} must be an array`);
      }
      merged[key].push(...items);
    }
  }
  return merged;
}

export function scrollContextScope({
  id,
  kind,
  root,
  hud,
  scope = emptyScrollSurfaceScope(),
} = {}) {
  const merged = mergeScrollSurfaceScopes(scope);
  return {
    id,
    kind,
    root,
    hud,
    ...merged,
  };
}

export function hasScrollLayoutBox(element) {
  return Boolean(element?.getClientRects?.().length);
}

export function hasVerticalScrollOverflow(element, tolerance = 1) {
  return Boolean(
    element &&
      Number(element.clientHeight) > 0 &&
      Number(element.scrollHeight) - Number(element.clientHeight) > tolerance
  );
}
