import type { ActionHintControlKind } from "../action-hint-scope.ts";

export const TASK_HINT_ALPHABET = "ASDFGHJKLQWERTYUIOPZXCVBNM";

export const ACTION_HINT_ACTION = Object.freeze({
  TASK_OPEN: "task.open",
  TASK_OPEN_RECOVERY: "task.open-recovery",
  TASK_SWITCH: "task.switch",
  TASK_SWITCHER_OPEN: "task.switcher.open",
  TASK_CREATE: "task.create",
  MODEL_CHOOSE: "task.model.choose",
  MODEL_PROVIDER_BROWSE: "task.model.provider.browse",
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
  NOTE_DETAILS_OPEN: "navigation.note-details.open",
  PROMPT_FOCUS: "task.prompt.focus",
  CURRENT_PLAN_DOCUMENT_OPEN: "task.current-plan.document.open",
  CURRENT_PLAN_STATUS_OPEN: "task.current-plan.status.open",
  WORKSPACE_SELECT: "navigation.workspace.select",
  PARENT: "navigation.parent",
  SETTINGS_SECTION: "navigation.settings.section",
  SECTION_OPEN: "navigation.section.open",
  DETAIL_VIEW: "navigation.detail.view",
  REVIEW_AXIS: "navigation.review.axis",
  FILE_OPEN: "navigation.file.open",
  NOTE_OPEN: "navigation.note.open",
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
  CONTROL_TEXTBOX_FOCUS: "control.textbox.focus",
  DIALOG_TEXTBOX_FOCUS: "dialog.textbox.focus",
  TERMINAL_OPEN: "navigation.terminal.open",
  TERMINAL_FOCUS: "terminal.focus",
});

export type ActionHintAction =
  (typeof ACTION_HINT_ACTION)[keyof typeof ACTION_HINT_ACTION];

const ACTION_HINT_ALLOCATION = Object.freeze({
  FIXED: "fixed",
  PREFIXED: "prefixed",
  AUTOMATIC: "automatic",
});

// How an action's code is chosen: one fixed key, a fixed prefix before a
// generated suffix, or the automatic pool.
type ActionHintPolicy =
  | {
      controlKind: ActionHintControlKind;
      allocation: typeof ACTION_HINT_ALLOCATION.FIXED;
      code: string;
    }
  | {
      controlKind: ActionHintControlKind;
      allocation: typeof ACTION_HINT_ALLOCATION.PREFIXED;
      prefix: string;
    }
  | {
      controlKind: ActionHintControlKind;
      allocation: typeof ACTION_HINT_ALLOCATION.AUTOMATIC;
    };

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
  // Every target in the Task switcher is this one action except its Close
  // button, so a prefix would cost a keystroke on every jump only to set the
  // rows apart from that one button.
  [ACTION_HINT_ACTION.TASK_SWITCH]: Object.freeze({
    controlKind: "button",
    allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
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
  [ACTION_HINT_ACTION.TERMINAL_FOCUS]: Object.freeze({
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
  [ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS]: Object.freeze({
    controlKind: "textbox",
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
  ...samePolicy(
    [
      ACTION_HINT_ACTION.WORKSPACE_SELECT,
      ACTION_HINT_ACTION.PARENT,
      ACTION_HINT_ACTION.SETTINGS_SECTION,
      ACTION_HINT_ACTION.SECTION_OPEN,
      ACTION_HINT_ACTION.DETAIL_VIEW,
      ACTION_HINT_ACTION.REVIEW_AXIS,
      ACTION_HINT_ACTION.FILE_OPEN,
      ACTION_HINT_ACTION.NOTE_OPEN,
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
      ACTION_HINT_ACTION.CURRENT_PLAN_STATUS_OPEN,
      ACTION_HINT_ACTION.MODEL_SELECT,
      ACTION_HINT_ACTION.MODEL_PROVIDER_BROWSE,
      ACTION_HINT_ACTION.REASONING_SELECT,
      ACTION_HINT_ACTION.SPEED_SELECT,
      ACTION_HINT_ACTION.PERMISSION_OPEN,
      ACTION_HINT_ACTION.PERMISSION_SELECT,
      ACTION_HINT_ACTION.REORDER_OPEN,
      ACTION_HINT_ACTION.REORDER_SELECT,
      ACTION_HINT_ACTION.REORDER_FINISH,
      ACTION_HINT_ACTION.TASK_SWITCHER_OPEN,
      ACTION_HINT_ACTION.GIT_OPEN,
      ACTION_HINT_ACTION.GIT_DESTINATION,
      ACTION_HINT_ACTION.GITHUB_OPEN,
      ACTION_HINT_ACTION.GITHUB_DESTINATION,
      ACTION_HINT_ACTION.TERMINAL_OPEN,
      ACTION_HINT_ACTION.TASK_DETAILS_OPEN,
      ACTION_HINT_ACTION.TASK_FORK,
      ACTION_HINT_ACTION.TASK_ARCHIVE,
      ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
      ACTION_HINT_ACTION.NOTE_DETAILS_OPEN,
    ],
    Object.freeze({
      controlKind: "button",
      allocation: ACTION_HINT_ALLOCATION.AUTOMATIC,
    }),
  ),
}) satisfies Record<ActionHintAction, ActionHintPolicy>;

type ActionHintPolicyTable = typeof ACTION_HINT_ACTION_POLICY;

// The actions that may sit on one kind of control.
export type ActionFor<Kind extends ActionHintControlKind> = {
  [Action in ActionHintAction]: ActionHintPolicyTable[Action]["controlKind"] extends Kind
    ? Action
    : never;
}[ActionHintAction];

const RESERVED_AUTOMATIC_PREFIXES = Object.freeze(["N", "M", "P", "T"]);
const AUTOMATIC_HINT_ROOT_ALPHABET = [...TASK_HINT_ALPHABET]
  .filter((key) => !RESERVED_AUTOMATIC_PREFIXES.includes(key))
  .join("");

export function matchesActionHintPolicy({
  actionId,
  controlKind,
}: {
  actionId?: string;
  controlKind?: string;
} = {}) {
  const policy = policyFor(actionId);
  return Boolean(policy && policy.controlKind === controlKind);
}

export function allocateActionHintCodes<
  Target extends { id: string; actionId: string; controlKind: string },
>(
  targets: Target[],
  { reserved = [] }: { reserved?: readonly string[] } = {},
): Array<Target & { code: string }> {
  const resolved = targets.map((target) => {
    const policy = policyFor(target.actionId);
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
  const automaticCodes = automaticHintCodes(automaticCount, reserved);
  let taskIndex = 0;
  let automaticIndex = 0;
  const allocated = resolved.map(({ target, policy }) => {
    const code =
      policy.allocation === ACTION_HINT_ALLOCATION.FIXED
        ? policy.code
        : policy.allocation === ACTION_HINT_ALLOCATION.PREFIXED
          ? `${policy.prefix}${taskCodes[taskIndex++]}`
          : (automaticCodes[automaticIndex++] as string);
    return { ...target, code };
  });
  assertPrefixFreeCodes(allocated.map((target) => target.code));
  return allocated;
}

export function automaticHintCodes(
  count: number,
  reserved: readonly string[] = [],
) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Automatic Hint count must be a non-negative integer.");
  }
  const rootAlphabet = [...AUTOMATIC_HINT_ROOT_ALPHABET]
    .filter((key) => !reserved.includes(key))
    .join("");
  return compactHintCodes(count, rootAlphabet);
}

export function taskHintSuffix(index: number, width: number) {
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

function compactHintCodes(count: number, rootAlphabet: string): string[] {
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
    const parent = expandedCodes[index] as string;
    for (const key of TASK_HINT_ALPHABET.slice(0, childCount)) {
      codes.push(`${parent}${key}`);
    }
    childrenNeeded -= childCount;
  }
  return codes;
}

function fixedWidthHintCodes(rootAlphabet: string, width: number) {
  let codes = [...rootAlphabet];
  for (let depth = 1; depth < width; depth += 1) {
    codes = codes.flatMap((prefix) =>
      [...TASK_HINT_ALPHABET].map((key) => `${prefix}${key}`),
    );
  }
  return codes;
}

export function normalizeActionHintKey(
  event: Partial<
    Pick<
      KeyboardEvent,
      | "isComposing"
      | "repeat"
      | "ctrlKey"
      | "altKey"
      | "metaKey"
      | "key"
      | "code"
    >
  > | null,
  {
    compositionActive = false,
    allowRepeat = false,
  }: { compositionActive?: boolean; allowRepeat?: boolean } = {},
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

export interface HintProgress {
  buffer: string;
  matches: string[];
  exact: string;
  status: "idle" | "partial" | "exact" | "no-match";
}

export function advanceHintBuffer(
  buffer: unknown,
  key: string,
  codes: Iterable<string>,
): HintProgress {
  const previous = `${buffer ?? ""}`;
  const availableCodes = [...codes];
  const next =
    key === "Backspace"
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
    status:
      next && matches.length === 0
        ? "no-match"
        : exact
          ? "exact"
          : next
            ? "partial"
            : "idle",
  };
}

export function isEditableElement(element: Element | null | undefined) {
  if (!element || typeof element.matches !== "function") {
    return false;
  }
  return element.matches(
    "input:not([type='button']):not([type='submit']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false'])",
  );
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

// Anything that carries the four edges, such as a `DOMRect`.
export type RectLike =
  | Partial<Record<"left" | "top" | "right" | "bottom", unknown>>
  | null
  | undefined;

export function normalizeRect(rect: RectLike): Rect | null {
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

export function intersectRects(rects: RectLike[]) {
  const normalized = rects.map(normalizeRect);
  if (!normalized.every((rect) => rect !== null) || normalized.length === 0) {
    return null;
  }
  return normalizeRect({
    left: Math.max(...normalized.map((rect) => rect.left)),
    top: Math.max(...normalized.map((rect) => rect.top)),
    right: Math.min(...normalized.map((rect) => rect.right)),
    bottom: Math.min(...normalized.map((rect) => rect.bottom)),
  });
}

export function visibleTargetRect(
  anchorRect: RectLike,
  clipRects: RectLike[],
  viewportRect: RectLike,
  occlusionRects: RectLike[] = [],
) {
  const anchor = normalizeRect(anchorRect);
  if (!anchor) {
    return null;
  }
  const visible = intersectRects([anchor, ...clipRects, viewportRect]);
  if (!visible) {
    return null;
  }
  if (occlusionRects.some((rect) => intersectRects([visible, rect]))) {
    return null;
  }
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  return centerX >= visible.left &&
    centerX <= visible.right &&
    centerY >= visible.top &&
    centerY <= visible.bottom
    ? visible
    : null;
}

export function clampBadgePosition(
  position: { left?: unknown; top?: unknown } | null | undefined,
  badgeSize: { width?: unknown; height?: unknown } | null | undefined,
  viewportRect: RectLike,
  margin = 4,
) {
  const viewport = normalizeRect(viewportRect);
  if (!viewport) {
    return {
      left: Number(position?.left) || 0,
      top: Number(position?.top) || 0,
    };
  }
  const width = Math.max(0, Number(badgeSize?.width) || 0);
  const height = Math.max(0, Number(badgeSize?.height) || 0);
  const minimumLeft = viewport.left + margin;
  const minimumTop = viewport.top + margin;
  const maximumLeft = Math.max(minimumLeft, viewport.right - width - margin);
  const maximumTop = Math.max(minimumTop, viewport.bottom - height - margin);
  return {
    left: clamp(Number(position?.left) || 0, minimumLeft, maximumLeft),
    top: clamp(Number(position?.top) || 0, minimumTop, maximumTop),
  };
}

export function rectsEqual(left: RectLike, right: RectLike, tolerance = 0.5) {
  const a = normalizeRect(left);
  const b = normalizeRect(right);
  if (!a || !b) {
    return a === b;
  }
  return (["left", "top", "right", "bottom"] as const).every(
    (key) => Math.abs(a[key] - b[key]) <= tolerance,
  );
}

// What binds a target to its control: the fields that, if any of them
// changes, retire the frozen target.
export interface ActionHintTargetBinding {
  id: string;
  actionId: string;
  controlKind: string;
  activationKey?: string;
  invalidationOwner: Element;
  control: Element;
  anchor: Element;
  clipRoots: Element[];
  occlusionRoots?: Element[];
}

export function sameActionHintTargetBinding(
  left: ActionHintTargetBinding | null | undefined,
  right: ActionHintTargetBinding | null | undefined,
) {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.actionId === right.actionId &&
      left.controlKind === right.controlKind &&
      left.activationKey === right.activationKey &&
      left.invalidationOwner === right.invalidationOwner &&
      left.control === right.control &&
      left.anchor === right.anchor &&
      sameElementSet(left.clipRoots, right.clipRoots) &&
      sameElementSet(left.occlusionRoots ?? [], right.occlusionRoots ?? []),
  );
}

export function reconcileActionHintTargets<
  Frozen extends ActionHintTargetBinding & { label: string; visibleRect: Rect },
>(
  frozenTargets: Frozen[],
  currentTargets: Array<
    ActionHintTargetBinding & {
      label: string;
      actionable: boolean;
      visibleRect: Rect | null;
    }
  >,
) {
  if (!Array.isArray(frozenTargets) || !Array.isArray(currentTargets)) {
    return null;
  }
  const currentById = new Map<string, (typeof currentTargets)[number]>();
  for (const target of currentTargets) {
    if (!target?.id || currentById.has(target.id)) {
      return null;
    }
    currentById.set(target.id, target);
  }
  const retiredOwners = new Set<Element>();
  for (const target of frozenTargets) {
    if (!target?.invalidationOwner) {
      return null;
    }
    const current = currentById.get(target.id);
    if (
      !current?.actionable ||
      !current.visibleRect ||
      !sameActionHintTargetBinding(target, current)
    ) {
      retiredOwners.add(target.invalidationOwner);
    }
  }
  return {
    retiredOwners: [...retiredOwners],
    targets: frozenTargets.flatMap((target): Frozen[] => {
      const current = currentById.get(target.id);
      if (
        retiredOwners.has(target.invalidationOwner) ||
        !current?.visibleRect
      ) {
        return [];
      }
      return [
        {
          ...target,
          label: current.label,
          visibleRect: current.visibleRect,
        },
      ];
    }),
  };
}

export function sortByVisualOrder<Target extends { visibleRect: Rect }>(
  targets: Target[],
) {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => {
      const vertical =
        left.target.visibleRect.top - right.target.visibleRect.top;
      if (Math.abs(vertical) > 0.5) {
        return vertical;
      }
      const horizontal =
        left.target.visibleRect.left - right.target.visibleRect.left;
      return Math.abs(horizontal) > 0.5 ? horizontal : left.index - right.index;
    })
    .map(({ target }) => target);
}

function assertUniqueTargetIds(targets: Array<{ id: string }>) {
  const ids = new Set<string>();
  for (const target of targets) {
    if (!target.id || ids.has(target.id)) {
      throw new Error(`Duplicate or empty Action Hint target id: ${target.id}`);
    }
    ids.add(target.id);
  }
}

// The visual viewport an Action Hint session was captured in.
export interface ActionHintViewport {
  rect: Rect | null;
  scrollLeft?: number;
  scrollTop?: number;
  scale: number;
  devicePixelRatio: number;
}

export function sameActionHintViewport(
  left: ActionHintViewport | null | undefined,
  right: ActionHintViewport | null | undefined,
) {
  if (!left || !right) {
    return false;
  }
  return Boolean(
    rectsEqual(left.rect, right.rect) &&
      Math.abs((left.scrollLeft ?? 0) - (right.scrollLeft ?? 0)) <= 0.5 &&
      Math.abs((left.scrollTop ?? 0) - (right.scrollTop ?? 0)) <= 0.5 &&
      Math.abs(left.scale - right.scale) <= 0.001 &&
      Math.abs(left.devicePixelRatio - right.devicePixelRatio) <= 0.001,
  );
}

function sameElementSet(left: unknown, right: unknown) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return (
    left.length === right.length &&
    left.every((element) => right.includes(element))
  );
}

function assertPrefixFreeCodes(codes: string[]) {
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Every action in `actions` sharing one policy, with the actions as its keys.
function samePolicy<Action extends ActionHintAction, Policy>(
  actions: readonly Action[],
  policy: Policy,
) {
  return Object.fromEntries(
    actions.map((action) => [action, policy]),
  ) as Record<Action, Policy>;
}

function policyFor(actionId: unknown): ActionHintPolicy | undefined {
  return Object.hasOwn(ACTION_HINT_ACTION_POLICY, `${actionId}`)
    ? ACTION_HINT_ACTION_POLICY[actionId as ActionHintAction]
    : undefined;
}
