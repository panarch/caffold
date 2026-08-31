export const TASK_HINT_ALPHABET = "ASDFGHJKLQWERTYUIOPZXCVBNM";

export const ACTION_HINT_ACTION = Object.freeze({
  TASK_OPEN: "task.open",
  TASK_OPEN_RECOVERY: "task.open-recovery",
  TASK_CREATE: "task.create",
  MODEL_CHOOSE: "task.model.choose",
  PROMPT_FOCUS: "task.prompt.focus",
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
  PAGE: "navigation.page",
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
    ACTION_HINT_ACTION.PAGE,
  ].map((actionId) => [actionId, Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
  })])),
});

const RESERVED_AUTOMATIC_PREFIXES = Object.freeze(["N", "M", "P", "T"]);

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
  const suffixWidth = taskHintSuffixWidth(taskCount);
  const automaticCodes = automaticHintCodes(automaticCount);
  let taskIndex = 0;
  let automaticIndex = 0;
  const allocated = resolved.map(({ target, policy }) => {
    const code = policy.allocation === ACTION_HINT_ALLOCATION.FIXED
      ? policy.code
      : policy.allocation === ACTION_HINT_ALLOCATION.PREFIXED
        ? `${policy.prefix}${taskHintSuffix(taskIndex++, suffixWidth)}`
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
  if (count === 0) {
    return [];
  }
  for (let width = 1; ; width += 1) {
    const codes = [];
    const capacity = TASK_HINT_ALPHABET.length ** width;
    for (let index = 0; index < capacity; index += 1) {
      const code = taskHintSuffix(index, width);
      if (RESERVED_AUTOMATIC_PREFIXES.some((prefix) => code.startsWith(prefix))) {
        continue;
      }
      codes.push(code);
      if (codes.length === count) {
        return codes;
      }
    }
  }
}

export function taskHintSuffixWidth(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Task Hint count must be a non-negative integer.");
  }
  let width = 1;
  while (count > TASK_HINT_ALPHABET.length ** width) {
    width += 1;
  }
  return width;
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

export function normalizeActionHintKey(
  event,
  { compositionActive = false } = {},
) {
  if (
    compositionActive ||
    event?.isComposing ||
    event?.repeat ||
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
