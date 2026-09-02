import {
  TASK_HINT_ALPHABET,
  intersectRects,
  normalizeRect,
  rectsEqual,
  sortByVisualOrder,
  taskHintSuffix,
} from "../action-hints.js";

export const SCROLL_COMMAND = Object.freeze({
  J: Object.freeze({ direction: 1, ratio: 0.1 }),
  K: Object.freeze({ direction: -1, ratio: 0.1 }),
  D: Object.freeze({ direction: 1, ratio: 0.5 }),
  U: Object.freeze({ direction: -1, ratio: 0.5 }),
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
  scrollTop,
  scrollHeight,
  clientHeight,
} = {}) {
  const policy = SCROLL_COMMAND[command];
  const height = Math.max(0, Number(clientHeight) || 0);
  const maximum = Math.max(0, (Number(scrollHeight) || 0) - height);
  const current = clamp(Number(scrollTop) || 0, 0, maximum);
  if (!policy) {
    return null;
  }
  const delta = Math.max(1, Math.round(height * policy.ratio));
  return clamp(current + policy.direction * delta, 0, maximum);
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

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
