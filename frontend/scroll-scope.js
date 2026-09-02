const SCROLL_SCOPE_LIST_KEYS = [
  "surfaces",
  "mutationRoots",
  "resizeElements",
  "scrollRoots",
];

const SCROLL_AXIS = Object.freeze({
  VERTICAL: "vertical",
  HORIZONTAL: "horizontal",
});

const SCROLL_AXES = Object.freeze([
  SCROLL_AXIS.VERTICAL,
  SCROLL_AXIS.HORIZONTAL,
]);

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

export function hasHorizontalScrollOverflow(element, tolerance = 1) {
  return Boolean(
    element &&
      Number(element.clientWidth) > 0 &&
      Number(element.scrollWidth) - Number(element.clientWidth) > tolerance
  );
}

export function normalizeScrollAxes(axes) {
  const values = axes === undefined ? [SCROLL_AXIS.VERTICAL] : axes;
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const declared = new Set();
  for (const axis of values) {
    if (!SCROLL_AXES.includes(axis) || declared.has(axis)) {
      return null;
    }
    declared.add(axis);
  }
  return SCROLL_AXES.filter((axis) => declared.has(axis));
}

export function availableScrollAxes(element, axes, tolerance = 1) {
  const declared = normalizeScrollAxes(axes);
  if (!declared) {
    return null;
  }
  return declared.filter((axis) =>
    axis === SCROLL_AXIS.VERTICAL
      ? hasVerticalScrollOverflow(element, tolerance)
      : hasHorizontalScrollOverflow(element, tolerance)
  );
}
