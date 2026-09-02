export const TASK_HINT_ALPHABET = "ASDFGHJKLQWERTYUIOPZXCVBNM";

export const ACTION_HINT_ACTION = Object.freeze({
  TASK_OPEN: "task.open",
  TASK_OPEN_RECOVERY: "task.open-recovery",
  TASK_CREATE: "task.create",
  MODEL_CHOOSE: "task.model.choose",
  MODEL_SELECT: "task.model.select",
  REASONING_SELECT: "task.reasoning.select",
  SPEED_SELECT: "task.speed.select",
  PERMISSION_OPEN: "task.permission.open",
  PERMISSION_SELECT: "task.permission.select",
  REORDER_OPEN: "task.reorder.open",
  REORDER_SELECT: "task.reorder.select",
  REORDER_HANDLE_FOCUS: "task.reorder.handle.focus",
  REORDER_FINISH: "task.reorder.finish",
  GIT_OPEN: "navigation.git.open",
  GIT_DESTINATION: "navigation.git.destination",
  GITHUB_OPEN: "navigation.github.open",
  GITHUB_DESTINATION: "navigation.github.destination",
  TASK_DETAILS_OPEN: "task.details.open",
  TASK_FORK: "task.fork",
  TASK_ARCHIVE: "task.archive",
  FILE_DETAILS_OPEN: "navigation.file-details.open",
  PROMPT_FOCUS: "task.prompt.focus",
  CURRENT_PLAN_DOCUMENT_OPEN: "task.current-plan.document.open",
  WORKSPACE_SELECT: "navigation.workspace.select",
  PARENT: "navigation.parent",
  SETTINGS_SECTION: "navigation.settings.section",
  SECTION_OPEN: "navigation.section.open",
  DETAIL_VIEW: "navigation.detail.view",
  REVIEW_AXIS: "navigation.review.axis",
  FILE_OPEN: "navigation.file.open",
  COMMIT_OPEN: "navigation.commit.open",
  GITHUB_MODE: "navigation.github.mode",
  ISSUE_OPEN: "navigation.issue.open",
  PULL_OPEN: "navigation.pull.open",
  PULL_FILES: "navigation.pull.files",
  GITHUB_TASK_START: "task.github.start",
  PAGE: "navigation.page",
  DIALOG_BUTTON: "dialog.button",
  BUTTON_ACTIVATE: "button.activate",
  DISCLOSURE_TOGGLE: "disclosure.toggle",
  LINK_OPEN: "link.open",
  CONTROL_RADIO_SELECT: "control.radio.select",
  CONTROL_SWITCH_TOGGLE: "control.switch.toggle",
  CONTROL_SELECT_OPEN: "control.select.open",
  CONTROL_RANGE_FOCUS: "control.range.focus",
  CONTROL_SEPARATOR_FOCUS: "control.separator.focus",
  DIALOG_TEXTBOX_FOCUS: "dialog.textbox.focus",
});

const ACTION_HINT_ALLOCATION = Object.freeze({
  FIXED: "fixed",
  PREFIXED: "prefixed",
  AUTOMATIC: "automatic",
});

const ACTION_HINT_ACTION_POLICY = Object.freeze({
  [ACTION_HINT_ACTION.TASK_OPEN]: Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.PREFIXED,
    prefix: "T",
  }),
  [ACTION_HINT_ACTION.TASK_OPEN_RECOVERY]: Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.PREFIXED,
    prefix: "T",
  }),
  [ACTION_HINT_ACTION.TASK_CREATE]: Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.FIXED,
    code: "N",
  }),
  [ACTION_HINT_ACTION.MODEL_CHOOSE]: Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.FIXED,
    code: "M",
  }),
  [ACTION_HINT_ACTION.PROMPT_FOCUS]: Object.freeze({
    controlKind: "textbox",
    allocation: ACTION_HINT_ALLOCATION.FIXED,
    code: "P",
  }),
  [ACTION_HINT_ACTION.DIALOG_TEXTBOX_FOCUS]: Object.freeze({
    controlKind: "textbox",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.CONTROL_RADIO_SELECT]: Object.freeze({
    controlKind: "radio",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE]: Object.freeze({
    controlKind: "switch",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.CONTROL_SELECT_OPEN]: Object.freeze({
    controlKind: "select",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS]: Object.freeze({
    controlKind: "range",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS]: Object.freeze({
    controlKind: "separator",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS]: Object.freeze({
    controlKind: "reorder-handle",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.DISCLOSURE_TOGGLE]: Object.freeze({
    controlKind: "disclosure",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  [ACTION_HINT_ACTION.LINK_OPEN]: Object.freeze({
    controlKind: "link",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  }),
  ...Object.fromEntries([
    ACTION_HINT_ACTION.WORKSPACE_SELECT,
    ACTION_HINT_ACTION.PARENT,
    ACTION_HINT_ACTION.SETTINGS_SECTION,
    ACTION_HINT_ACTION.SECTION_OPEN,
    ACTION_HINT_ACTION.DETAIL_VIEW,
    ACTION_HINT_ACTION.REVIEW_AXIS,
    ACTION_HINT_ACTION.FILE_OPEN,
    ACTION_HINT_ACTION.COMMIT_OPEN,
    ACTION_HINT_ACTION.GITHUB_MODE,
    ACTION_HINT_ACTION.ISSUE_OPEN,
    ACTION_HINT_ACTION.PULL_OPEN,
    ACTION_HINT_ACTION.PULL_FILES,
    ACTION_HINT_ACTION.GITHUB_TASK_START,
    ACTION_HINT_ACTION.PAGE,
    ACTION_HINT_ACTION.DIALOG_BUTTON,
    ACTION_HINT_ACTION.BUTTON_ACTIVATE,
    ACTION_HINT_ACTION.CURRENT_PLAN_DOCUMENT_OPEN,
    ACTION_HINT_ACTION.MODEL_SELECT,
    ACTION_HINT_ACTION.REASONING_SELECT,
    ACTION_HINT_ACTION.SPEED_SELECT,
    ACTION_HINT_ACTION.PERMISSION_OPEN,
    ACTION_HINT_ACTION.PERMISSION_SELECT,
    ACTION_HINT_ACTION.REORDER_OPEN,
    ACTION_HINT_ACTION.REORDER_SELECT,
    ACTION_HINT_ACTION.REORDER_FINISH,
    ACTION_HINT_ACTION.GIT_OPEN,
    ACTION_HINT_ACTION.GIT_DESTINATION,
    ACTION_HINT_ACTION.GITHUB_OPEN,
    ACTION_HINT_ACTION.GITHUB_DESTINATION,
    ACTION_HINT_ACTION.TASK_DETAILS_OPEN,
    ACTION_HINT_ACTION.TASK_FORK,
    ACTION_HINT_ACTION.TASK_ARCHIVE,
    ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
  ].map((actionId) => [actionId, Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  })])),
});

const RESERVED_AUTOMATIC_PREFIXES = Object.freeze(["N", "M", "P", "T"]);
const AUTOMATIC_HINT_ROOT_ALPHABET = [...TASK_HINT_ALPHABET]
  .filter((key) => !RESERVED_AUTOMATIC_PREFIXES.includes(key))
  .join("");

export function matchesActionHintPolicy({
  actionId,
  controlKind,
} = {}) {
  const policy = ACTION_HINT_ACTION_POLICY[actionId];
  return Boolean(policy && policy.controlKind === controlKind);
}

export function allocateActionHintCodes(targets) {
  const resolved = targets.map((target) => {
    const policy = ACTION_HINT_ACTION_POLICY[target.actionId];
    if (!policy || policy.controlKind !== target.controlKind) {
      throw new Error(`Unsupported Action Hint action: ${target.actionId}`);
    }
    return { target, policy };
  });
  assertUniqueTargetIds(targets);
  const taskCount = resolved.filter(
    ({ policy }) => policy.allocation === ACTION_HINT_ALLOCATION.PREFIXED,
  ).length;
  const automaticCount = resolved.filter(
    ({ policy }) => policy.allocation === ACTION_HINT_ALLOCATION.AUTOMATIC,
  ).length;
  const taskCodes = compactHintCodes(taskCount, TASK_HINT_ALPHABET);
  const automaticCodes = automaticHintCodes(automaticCount);
  let taskIndex = 0;
  let automaticIndex = 0;
  const allocated = resolved.map(({ target, policy }) => {
    const code = policy.allocation === ACTION_HINT_ALLOCATION.FIXED
      ? policy.code
      : policy.allocation === ACTION_HINT_ALLOCATION.PREFIXED
        ? `${policy.prefix}${taskCodes[taskIndex++]}`
        : automaticCodes[automaticIndex++];
    return { ...target, code };
  });
  assertPrefixFreeCodes(allocated.map((target) => target.code));
  return allocated;
}

export function automaticHintCodes(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Automatic Hint count must be a non-negative integer.");
  }
  return compactHintCodes(count, AUTOMATIC_HINT_ROOT_ALPHABET);
}

export function taskHintSuffix(index, width) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Task Hint index must be a non-negative integer.");
  }
  if (!Number.isInteger(width) || width < 1) {
    throw new Error("Task Hint suffix width must be a positive integer.");
  }
  const capacity = TASK_HINT_ALPHABET.length ** width;
  if (index >= capacity) {
    throw new Error("Task Hint index exceeds the selected suffix width.");
  }
  let value = index;
  let suffix = "";
  for (let place = 0; place < width; place += 1) {
    suffix = TASK_HINT_ALPHABET[value % TASK_HINT_ALPHABET.length] + suffix;
    value = Math.floor(value / TASK_HINT_ALPHABET.length);
  }
  return suffix;
}

function compactHintCodes(count, rootAlphabet) {
  if (count === 0) {
    return [];
  }
  const continuationCapacity = TASK_HINT_ALPHABET.length;
  let maximumDepth = 1;
  let maximumCapacity = rootAlphabet.length;
  while (count > maximumCapacity) {
    maximumDepth += 1;
    maximumCapacity *= continuationCapacity;
  }
  if (maximumDepth === 1) {
    return [...rootAlphabet].slice(0, count);
  }

  const shallowCodes = fixedWidthHintCodes(rootAlphabet, maximumDepth - 1);
  const additionalLeaves = count - shallowCodes.length;
  // Replacing one shallow leaf with every continuation adds up to one less
  // than the continuation capacity. Expand as few tail leaves as possible.
  const expandedCount = Math.ceil(
    additionalLeaves / (continuationCapacity - 1),
  );
  const retainedCount = shallowCodes.length - expandedCount;
  const codes = shallowCodes.slice(0, retainedCount);
  const expandedCodes = shallowCodes.slice(retainedCount);
  let childrenNeeded = count - retainedCount;

  for (let index = 0; index < expandedCodes.length; index += 1) {
    const remainingParents = expandedCodes.length - index - 1;
    const childCount = Math.min(
      continuationCapacity,
      childrenNeeded - remainingParents * 2,
    );
    const parent = expandedCodes[index];
    for (const key of TASK_HINT_ALPHABET.slice(0, childCount)) {
      codes.push(`${parent}${key}`);
    }
    childrenNeeded -= childCount;
  }
  return codes;
}

function fixedWidthHintCodes(rootAlphabet, width) {
  let codes = [...rootAlphabet];
  for (let depth = 1; depth < width; depth += 1) {
    codes = codes.flatMap((prefix) =>
      [...TASK_HINT_ALPHABET].map((key) => `${prefix}${key}`)
    );
  }
  return codes;
}

export function normalizeActionHintKey(
  event,
  { compositionActive = false, allowRepeat = false } = {},
) {
  if (
    compositionActive ||
    event?.isComposing ||
    (!allowRepeat && event?.repeat) ||
    event?.ctrlKey ||
    event?.altKey ||
    event?.metaKey
  ) {
    return "";
  }
  const key = `${event?.key ?? ""}`;
  if (/^[a-z]$/i.test(key)) {
    return key.toUpperCase();
  }
  const code = `${event?.code ?? ""}`;
  return /^Key[A-Z]$/.test(code) ? code.slice(3) : "";
}

export function advanceHintBuffer(buffer, key, codes) {
  const previous = `${buffer ?? ""}`;
  const availableCodes = [...codes];
  const next = key === "Backspace"
    ? previous.slice(0, -1)
    : /^[A-Z]$/.test(key)
      ? `${previous}${key}`
      : previous;
  const matches = availableCodes.filter((code) => code.startsWith(next));
  const exact = matches.find((code) => code === next) ?? "";
  return {
    buffer: next,
    matches,
    exact,
    status: next && matches.length === 0
      ? "no-match"
      : exact
        ? "exact"
        : next
          ? "partial"
          : "idle",
  };
}

export function isEditableElement(element) {
  if (!element || typeof element.matches !== "function") {
    return false;
  }
  return element.matches(
    "input:not([type='button']):not([type='submit']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false'])",
  );
}

export function normalizeRect(rect) {
  const left = Number(rect?.left);
  const top = Number(rect?.top);
  const right = Number(rect?.right);
  const bottom = Number(rect?.bottom);
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function intersectRects(rects) {
  const normalized = rects.map(normalizeRect);
  if (normalized.some((rect) => !rect) || normalized.length === 0) {
    return null;
  }
  return normalizeRect({
    left: Math.max(...normalized.map((rect) => rect.left)),
    top: Math.max(...normalized.map((rect) => rect.top)),
    right: Math.min(...normalized.map((rect) => rect.right)),
    bottom: Math.min(...normalized.map((rect) => rect.bottom)),
  });
}

export function visibleTargetRect(anchorRect, clipRects, viewportRect) {
  const anchor = normalizeRect(anchorRect);
  if (!anchor) {
    return null;
  }
  const visible = intersectRects([anchor, ...clipRects, viewportRect]);
  if (!visible) {
    return null;
  }
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  return centerX >= visible.left && centerX <= visible.right &&
      centerY >= visible.top && centerY <= visible.bottom
    ? visible
    : null;
}

export function clampBadgePosition(
  position,
  badgeSize,
  viewportRect,
  margin = 4,
) {
  const viewport = normalizeRect(viewportRect);
  if (!viewport) {
    return { left: Number(position?.left) || 0, top: Number(position?.top) || 0 };
  }
  const width = Math.max(0, Number(badgeSize?.width) || 0);
  const height = Math.max(0, Number(badgeSize?.height) || 0);
  const minimumLeft = viewport.left + margin;
  const minimumTop = viewport.top + margin;
  const maximumLeft = Math.max(
    minimumLeft,
    viewport.right - width - margin,
  );
  const maximumTop = Math.max(
    minimumTop,
    viewport.bottom - height - margin,
  );
  return {
    left: clamp(Number(position?.left) || 0, minimumLeft, maximumLeft),
    top: clamp(Number(position?.top) || 0, minimumTop, maximumTop),
  };
}

export function preferredBadgePosition(
  target,
  badgeSize,
  viewportRect,
  margin = 4,
) {
  const visibleRect = normalizeRect(target?.visibleRect);
  if (!visibleRect) {
    return { left: 0, top: 0 };
  }
  if (target?.controlKind !== "select") {
    return { left: visibleRect.left, top: visibleRect.top };
  }

  const height = Math.max(0, Number(badgeSize?.height) || 0);
  const viewport = normalizeRect(viewportRect);
  const below = visibleRect.bottom + margin;
  const top = !viewport || below + height <= viewport.bottom - margin
    ? below
    : visibleRect.top - height - margin;
  return {
    left: visibleRect.left,
    top,
  };
}

export function rectsEqual(left, right, tolerance = 0.5) {
  const a = normalizeRect(left);
  const b = normalizeRect(right);
  if (!a || !b) {
    return a === b;
  }
  return ["left", "top", "right", "bottom"].every(
    (key) => Math.abs(a[key] - b[key]) <= tolerance,
  );
}

export function sameActionHintTopology(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return Boolean(
      other &&
        entry.id === other.id &&
        entry.actionId === other.actionId &&
        entry.controlKind === other.controlKind &&
        entry.activationKey === other.activationKey &&
        entry.actionable === other.actionable &&
        entry.control === other.control &&
        entry.anchor === other.anchor &&
        sameElementSet(entry.clipRoots, other.clipRoots),
    );
  });
}

export function sameActionHintSnapshot(left, right) {
  if (
    !left ||
    !right ||
    !sameActionHintTopology(left.topology, right.topology) ||
    !sameViewport(left.viewport, right.viewport) ||
    !sameDependencies(left.dependencies, right.dependencies) ||
    !sameElementSet(left.mutationRoots, right.mutationRoots) ||
    !sameElementSet(left.scrollRoots, right.scrollRoots) ||
    left.targets.length !== right.targets.length
  ) {
    return false;
  }
  return left.targets.every((target, index) => {
    const other = right.targets[index];
    return Boolean(
      other &&
        target.id === other.id &&
        target.actionId === other.actionId &&
        target.controlKind === other.controlKind &&
        target.code === other.code &&
        target.control === other.control &&
        target.anchor === other.anchor &&
        rectsEqual(target.visibleRect, other.visibleRect),
    );
  });
}

export function sortByVisualOrder(targets) {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => {
      const vertical = left.target.visibleRect.top - right.target.visibleRect.top;
      if (Math.abs(vertical) > 0.5) {
        return vertical;
      }
      const horizontal = left.target.visibleRect.left - right.target.visibleRect.left;
      return Math.abs(horizontal) > 0.5 ? horizontal : left.index - right.index;
    })
    .map(({ target }) => target);
}

function assertUniqueTargetIds(targets) {
  const ids = new Set();
  for (const target of targets) {
    if (!target.id || ids.has(target.id)) {
      throw new Error(`Duplicate or empty Action Hint target id: ${target.id}`);
    }
    ids.add(target.id);
  }
}

function sameViewport(left, right) {
  if (!left || !right) {
    return false;
  }
  return Boolean(
    rectsEqual(left.rect, right.rect) &&
      Math.abs(left.scale - right.scale) <= 0.001 &&
      Math.abs(left.devicePixelRatio - right.devicePixelRatio) <= 0.001,
  );
}

function sameDependencies(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return left.length === right.length && left.every((dependency, index) => {
    const other = right[index];
    return Boolean(
      other &&
        dependency.element === other.element &&
        rectsEqual(dependency.rect, other.rect),
    );
  });
}

function sameElementSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return left.length === right.length && left.every(
    (element) => right.includes(element),
  );
}

function assertPrefixFreeCodes(codes) {
  const unique = new Set(codes);
  if (unique.size !== codes.length) {
    throw new Error("Action Hint codes must be unique.");
  }
  for (const code of codes) {
    for (const other of codes) {
      if (code !== other && other.startsWith(code)) {
        throw new Error("Action Hint codes must be prefix-free.");
      }
    }
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
