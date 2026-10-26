import {
  intersectRects,
  normalizeRect,
  type Rect,
  type RectLike,
  rectsEqual,
  sortByVisualOrder,
  TASK_HINT_ALPHABET,
  taskHintSuffix,
} from "../action-hints/model.ts";
import type { ScrollAxis } from "../scroll-scope.ts";
import { KEYBOARD_NAVIGATION_KEY } from "./shortcuts.ts";

interface ScrollCommand {
  axis: ScrollAxis;
  direction: 1 | -1;
  ratio: number;
}

export const SCROLL_COMMAND: Readonly<Record<string, ScrollCommand>> =
  Object.freeze({
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

// The context a Scroll session belongs to, as far as sessions compare it.
interface ScrollContextIdentity {
  id: string;
  kind: string;
  root: Element;
  presentation: Element;
}

interface ScrollViewport {
  rect: Rect | null;
  scale: number;
  devicePixelRatio: number;
}

// A surface as a Scroll session holds it: where it scrolls, along which axes,
// and where it shows.
interface SessionScrollSurface {
  id: string;
  scrollport: Element;
  axes: readonly string[];
  availableAxes: readonly string[];
  clipRoots: readonly Element[];
  visibleRect: Rect;
}

export interface ScrollSelectionSnapshot {
  context: ScrollContextIdentity;
  contextRect: Rect | null;
  viewport: ScrollViewport;
  surfaces: readonly (SessionScrollSurface & { code: string })[];
}

export interface ActiveScrollBinding extends SessionScrollSurface {
  context: ScrollContextIdentity;
  viewport: ScrollViewport;
}

export function allocateScrollSurfaceCodes<Surface extends { id: string }>(
  surfaces: readonly Surface[],
): Array<Surface & { code: string }> {
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (!surface.id || ids.has(surface.id)) {
      throw new Error(`Duplicate or empty Scroll surface id: ${surface.id}`);
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
  scrollportRect: RectLike,
  clipRects: RectLike[],
  viewportRect: RectLike,
) {
  return intersectRects([scrollportRect, ...clipRects, viewportRect]);
}

export function orderScrollSurfaces<Surface extends { visibleRect: Rect }>(
  surfaces: Surface[],
) {
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
}: {
  command: string;
  availableAxes?: readonly string[];
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  scrollLeft?: number;
  scrollWidth?: number;
  clientWidth?: number;
}) {
  const policy = SCROLL_COMMAND[command];
  if (!policy || !availableAxes.includes(policy.axis)) {
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

export function sameScrollSelectionSnapshot(
  left: ScrollSelectionSnapshot | null | undefined,
  right: ScrollSelectionSnapshot | null | undefined,
) {
  if (
    !left ||
    !right ||
    !sameScrollContext(left.context, right.context) ||
    !rectsEqual(left.contextRect, right.contextRect) ||
    !sameViewport(left.viewport, right.viewport) ||
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
        rectsEqual(surface.visibleRect, other.visibleRect),
    );
  });
}

export function sameActiveScrollBinding(
  left: ActiveScrollBinding | null | undefined,
  right: ActiveScrollBinding | null | undefined,
) {
  return Boolean(
    left &&
      right &&
      sameScrollContext(left.context, right.context) &&
      sameViewport(left.viewport, right.viewport) &&
      left.id === right.id &&
      left.scrollport === right.scrollport &&
      sameStringList(left.axes, right.axes) &&
      sameStringList(left.availableAxes, right.availableAxes) &&
      sameElementSet(left.clipRoots, right.clipRoots),
  );
}

export function normalizedContextRect(
  contextRoot: Element | null | undefined,
  viewportRect: RectLike,
) {
  const rootRect = normalizeRect(contextRoot?.getBoundingClientRect());
  return rootRect ? intersectRects([rootRect, viewportRect]) : null;
}

function sameScrollContext(
  left: ScrollContextIdentity,
  right: ScrollContextIdentity,
) {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.root === right.root &&
    left.presentation === right.presentation
  );
}

function sameViewport(left: ScrollViewport, right: ScrollViewport) {
  return (
    left.scale === right.scale &&
    left.devicePixelRatio === right.devicePixelRatio &&
    rectsEqual(left.rect, right.rect)
  );
}

function sameElementSet(left: readonly Element[], right: readonly Element[]) {
  return (
    left.length === right.length &&
    left.every((element) => right.includes(element))
  );
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
