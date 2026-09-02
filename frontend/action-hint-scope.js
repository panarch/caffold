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
  anchor = control,
  clipRoots,
  isActionable,
}) {
  return focusAndClickActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "button",
    control,
    anchor,
    clipRoots,
    isActionable,
  });
}

export function disclosureActionHintTarget({
  id,
  actionId,
  label,
  control,
  anchor = control,
  clipRoots,
  isActionable,
}) {
  return focusAndClickActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "disclosure",
    control,
    anchor,
    clipRoots,
    isActionable,
  });
}

export function radioActionHintTarget({
  id,
  actionId,
  label,
  control,
  anchor = control,
  clipRoots,
  isActionable,
}) {
  return focusAndClickActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "radio",
    control,
    anchor,
    clipRoots,
    isActionable,
  });
}

export function switchActionHintTarget({
  id,
  actionId,
  label,
  control,
  anchor = control,
  clipRoots,
  isActionable,
}) {
  return focusAndClickActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "switch",
    control,
    anchor,
    clipRoots,
    isActionable,
  });
}

export function textboxActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  return focusActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "textbox",
    control,
    clipRoots,
    isActionable,
  });
}

export function selectActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  const target = focusActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "select",
    control,
    clipRoots,
    isActionable,
  });
  return {
    ...target,
    activate: () => {
      control.focus({ preventScroll: true });
      try {
        control.showPicker?.();
      } catch {
        // Focus is the progressive fallback when a native picker is unavailable.
      }
    },
  };
}

export function rangeActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  return focusActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "range",
    control,
    clipRoots,
    isActionable,
  });
}

export function separatorActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  return focusActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "separator",
    control,
    clipRoots,
    isActionable,
  });
}

export function reorderHandleActionHintTarget({
  id,
  actionId,
  label,
  control,
  clipRoots,
  isActionable,
}) {
  return focusActionHintTarget({
    id,
    actionId,
    label,
    controlKind: "reorder-handle",
    control,
    clipRoots,
    isActionable,
  });
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

function focusActionHintTarget({
  id,
  actionId,
  label,
  controlKind,
  control,
  anchor = control,
  clipRoots,
  isActionable,
}) {
  return {
    id,
    actionId,
    label,
    controlKind,
    control,
    anchor,
    clipRoots,
    isActionable,
    activate: () => control.focus({ preventScroll: true }),
  };
}

function focusAndClickActionHintTarget(options) {
  const target = focusActionHintTarget(options);
  return {
    ...target,
    activate: () => {
      options.control.focus({ preventScroll: true });
      options.control.click();
    },
  };
}
