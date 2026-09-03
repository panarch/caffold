import {
  TASK_HINT_ALPHABET,
  intersectRects,
  normalizeRect,
  rectsEqual,
  sortByVisualOrder,
  taskHintSuffix,
} from "../action-hints.js";
import { KEYBOARD_NAVIGATION_KEY } from "./shortcuts.js";

export const SCROLL_COMMAND = Object.freeze({
  [KEYBOARD_NAVIGATION_KEY.SCROLL_DOWN]: Object.freeze({
    axis: "vertical",
    direction: 1,
    ratio: 0.1,
  }),
  [KEYBOARD_NAVIGATION_KEY.SCROLL_UP]: Object.freeze({
    axis: "vertical",
    direction: -1,
    ratio: 0.1,
  }),
  [KEYBOARD_NAVIGATION_KEY.SCROLL_HALF_DOWN]: Object.freeze({
    axis: "vertical",
    direction: 1,
    ratio: 0.5,
  }),
  [KEYBOARD_NAVIGATION_KEY.SCROLL_HALF_UP]: Object.freeze({
    axis: "vertical",
    direction: -1,
    ratio: 0.5,
  }),
  [KEYBOARD_NAVIGATION_KEY.SCROLL_LEFT]: Object.freeze({
    axis: "horizontal",
    direction: -1,
    ratio: 0.1,
  }),
  [KEYBOARD_NAVIGATION_KEY.SCROLL_RIGHT]: Object.freeze({
    axis: "horizontal",
    direction: 1,
    ratio: 0.1,
  }),
});

export function allocateScrollSurfaceCodes(surfaces) {
  if (!Array.isArray(surfaces)) {
    throw new TypeError("Scroll surfaces must be an array.");
  }
  const ids = new Set();
  for (const surface of surfaces) {
    if (!surface?.id || ids.has(surface.id)) {
      throw new Error(`Duplicate or empty Scroll surface id: ${surface?.id}`);
    }
    ids.add(surface.id);
  }
  if (surfaces.length === 0) {
    return [];
  }
  let width = 1;
  while (surfaces.length > TASK_HINT_ALPHABET.length ** width) {
    width += 1;
  }
  return surfaces.map((surface, index) => ({
    ...surface,
    code: taskHintSuffix(index, width),
  }));
}

export function visibleScrollSurfaceRect(
  scrollportRect,
  clipRects,
  viewportRect,
) {
  return intersectRects([scrollportRect, ...clipRects, viewportRect]);
}

export function orderScrollSurfaces(surfaces) {
  return sortByVisualOrder(surfaces);
}

export function scrollCommandPosition({
  command,
  availableAxes = ["vertical"],
  scrollTop,
  scrollHeight,
  clientHeight,
  scrollLeft,
  scrollWidth,
  clientWidth,
} = {}) {
  const policy = SCROLL_COMMAND[command];
  if (
    !policy ||
    !Array.isArray(availableAxes) ||
    !availableAxes.includes(policy.axis)
  ) {
    return null;
  }
  const isVertical = policy.axis === "vertical";
  const clientSize = Math.max(
    0,
    Number(isVertical ? clientHeight : clientWidth) || 0,
  );
  const scrollSize = Math.max(
    0,
    Number(isVertical ? scrollHeight : scrollWidth) || 0,
  );
  const maximum = Math.max(0, scrollSize - clientSize);
  const current = clamp(
    Number(isVertical ? scrollTop : scrollLeft) || 0,
    0,
    maximum,
  );
  const delta = Math.max(1, Math.round(clientSize * policy.ratio));
  return {
    axis: policy.axis,
    position: clamp(current + policy.direction * delta, 0, maximum),
  };
}

export function sameScrollSelectionSnapshot(left, right) {
  if (
    !left ||
    !right ||
    left.context.id !== right.context.id ||
    left.context.kind !== right.context.kind ||
    left.context.root !== right.context.root ||
    left.context.hud !== right.context.hud ||
    left.context.selector !== right.context.selector ||
    !rectsEqual(left.contextRect, right.contextRect) ||
    left.viewport.scale !== right.viewport.scale ||
    left.viewport.devicePixelRatio !== right.viewport.devicePixelRatio ||
    !rectsEqual(left.viewport.rect, right.viewport.rect) ||
    left.surfaces.length !== right.surfaces.length
  ) {
    return false;
  }
  return left.surfaces.every((surface, index) => {
    const other = right.surfaces[index];
    return Boolean(
      other &&
        surface.id === other.id &&
        surface.code === other.code &&
        surface.scrollport === other.scrollport &&
        sameStringList(surface.axes, other.axes) &&
        sameStringList(surface.availableAxes, other.availableAxes) &&
        sameElementSet(surface.clipRoots, other.clipRoots) &&
        rectsEqual(surface.visibleRect, other.visibleRect)
    );
  });
}

export function sameActiveScrollBinding(left, right) {
  return Boolean(
    left &&
      right &&
      left.context.id === right.context.id &&
      left.context.kind === right.context.kind &&
      left.context.root === right.context.root &&
      left.context.hud === right.context.hud &&
      left.viewport.scale === right.viewport.scale &&
      left.viewport.devicePixelRatio === right.viewport.devicePixelRatio &&
      rectsEqual(left.viewport.rect, right.viewport.rect) &&
      left.id === right.id &&
      left.scrollport === right.scrollport &&
      sameStringList(left.axes, right.axes) &&
      sameStringList(left.availableAxes, right.availableAxes) &&
      sameElementSet(left.clipRoots, right.clipRoots)
  );
}

export function normalizedContextRect(contextRoot, viewportRect) {
  const rootRect = normalizeRect(contextRoot?.getBoundingClientRect?.());
  return rootRect ? intersectRects([rootRect, viewportRect]) : null;
}

function sameElementSet(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((element) => right.includes(element));
}

function sameStringList(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
