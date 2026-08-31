const ACTION_HINT_SCOPE_LIST_KEYS = [
  "targets",
  "mutationRoots",
  "scrollRoots",
];

export function emptyActionHintScope() {
  return {
    blocked: false,
    targets: [],
    mutationRoots: [],
    scrollRoots: [],
  };
}

export function buttonActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  return {
    id,
    actionId,
    label,
    controlKind: "button",
    control,
    anchor: control,
    clipRoots,
    isActionable,
    activate: () => {
      control.focus({ preventScroll: true });
      control.click();
    },
  };
}

export function hasActionHintLayoutBox(element) {
  return Boolean(element?.getClientRects?.().length);
}

export function mergeActionHintScopes(...scopes) {
  const merged = emptyActionHintScope();
  for (const scope of scopes) {
    if (scope == null) {
      continue;
    }
    if (typeof scope !== "object") {
      throw new TypeError("Action Hint scope must be an object");
    }
    merged.blocked ||= Boolean(scope.blocked);
    for (const key of ACTION_HINT_SCOPE_LIST_KEYS) {
      const items = scope[key];
      if (items == null) {
        continue;
      }
      if (!Array.isArray(items)) {
        throw new TypeError(`Action Hint scope ${key} must be an array`);
      }
      merged[key].push(...items);
    }
  }
  return merged;
}
