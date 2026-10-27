import {
  type DeclaredElement,
  ElementDeclarations,
} from "./element-declarations.js";

export type ScrollAxis = "vertical" | "horizontal";

export interface ScrollSurface {
  id: string;
  label: string;
  scrollport: Element;
  axes?: ScrollAxis[];
  clipRoots: Element[];
}

export interface ScrollSurfaceScope {
  blocked: boolean;
  surfaces: ScrollSurface[];
  mutationRoots: Node[];
  resizeElements: Element[];
  scrollRoots: Element[];
}

// One surface as its owner's template declares it, on the scrollport itself.
export interface ScrollSurfaceDeclaration {
  // Its name within the owner. The scope id the parent passes goes in front.
  id: string;
  // What the selector calls it, from the owner's name. Left out, the owner's
  // name itself.
  label?: (name: string) => string;
  axes?: ScrollAxis[];
  // Whether Scroll mode may move it now. Left out, it may.
  when?: boolean;
  // What scrolls when that is not the element it sits on, such as the host
  // itself, which no template draws.
  scrollport?: () => Element | null | undefined;
  clipRoots?: () => Array<Element | null | undefined>;
}

export interface ScrollSurfacePull {
  scopeId?: string;
  // The owner's name, which its surfaces are called by.
  label?: string;
  clipRoots?: Element[];
  // The owner's modal or popover to read. Left out, the surfaces outside
  // them.
  contextRoot?: Element | null;
}

/**
 * The Scroll surfaces one component declares in its template.
 *
 * Like `ActionHints`, each declaration rides on its scrollport, and `scope()`
 * reads what the last draw declared.
 */
export class ScrollSurfaces {
  private readonly owner: Element;
  private readonly declarations: ElementDeclarations<ScrollSurfaceDeclaration>;

  constructor(owner: Element) {
    this.owner = owner;
    this.declarations = new ElementDeclarations(owner);
  }

  surface(declaration: ScrollSurfaceDeclaration) {
    return this.declarations.on(declaration);
  }

  scope(pull: ScrollSurfacePull = {}): ScrollSurfaceScope {
    return declaredScrollSurfaceScope(
      this.owner,
      this.declarations.list(pull.contextRoot),
      pull,
    );
  }
}

export function declaredScrollSurfaceScope(
  owner: Element,
  declarations: readonly DeclaredElement<ScrollSurfaceDeclaration>[],
  pull: ScrollSurfacePull,
): ScrollSurfaceScope {
  const name = pull.label ?? "";
  const surfaces = declarations.flatMap(
    ({ element, value: declaration }): ScrollSurface[] => {
      const label = declaration.label ? declaration.label(name) : name;
      const scrollport = declaration.scrollport
        ? declaration.scrollport()
        : element;
      if (
        declaration.when === false ||
        !label ||
        !scrollport ||
        !hasScrollLayoutBox(scrollport)
      ) {
        return [];
      }
      return [
        {
          id: pull.scopeId
            ? `${pull.scopeId}:${declaration.id}`
            : declaration.id,
          label,
          scrollport,
          axes: declaration.axes,
          clipRoots: [
            ...(declaration.clipRoots?.() ?? []).filter(
              (root): root is Element => root != null,
            ),
            ...(pull.clipRoots ?? []),
          ],
        },
      ];
    },
  );
  const scrollports = surfaces.map((surface) => surface.scrollport);
  return {
    blocked: false,
    surfaces,
    mutationRoots: [owner],
    resizeElements: [owner, ...scrollports],
    scrollRoots: scrollports,
  };
}

const SCROLL_SCOPE_LIST_KEYS = [
  "surfaces",
  "mutationRoots",
  "resizeElements",
  "scrollRoots",
] as const;

const SCROLL_AXIS = Object.freeze({
  VERTICAL: "vertical",
  HORIZONTAL: "horizontal",
});

const SCROLL_AXES: readonly ScrollAxis[] = Object.freeze([
  SCROLL_AXIS.VERTICAL,
  SCROLL_AXIS.HORIZONTAL,
]);

export function emptyScrollSurfaceScope(): ScrollSurfaceScope {
  return {
    blocked: false,
    surfaces: [],
    mutationRoots: [],
    resizeElements: [],
    scrollRoots: [],
  };
}

export function mergeScrollSurfaceScopes(
  ...scopes: Array<Partial<ScrollSurfaceScope> | null | undefined>
): ScrollSurfaceScope {
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
      (merged[key] as unknown[]).push(...items);
    }
  }
  return merged;
}

export function hasScrollLayoutBox(element: Element | null | undefined) {
  return Boolean(element?.getClientRects?.().length);
}

export function hasVerticalScrollOverflow(
  element: Element | null | undefined,
  tolerance = 1,
) {
  return Boolean(
    element &&
      Number(element.clientHeight) > 0 &&
      Number(element.scrollHeight) - Number(element.clientHeight) > tolerance,
  );
}

export function hasHorizontalScrollOverflow(
  element: Element | null | undefined,
  tolerance = 1,
) {
  return Boolean(
    element &&
      Number(element.clientWidth) > 0 &&
      Number(element.scrollWidth) - Number(element.clientWidth) > tolerance,
  );
}

export function normalizeScrollAxes(axes: unknown): ScrollAxis[] | null {
  const values = axes === undefined ? [SCROLL_AXIS.VERTICAL] : axes;
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const declared = new Set<unknown>();
  for (const axis of values) {
    if (
      !(SCROLL_AXES as readonly unknown[]).includes(axis) ||
      declared.has(axis)
    ) {
      return null;
    }
    declared.add(axis);
  }
  return SCROLL_AXES.filter((axis) => declared.has(axis));
}

export function availableScrollAxes(
  element: Element,
  axes: unknown,
  tolerance = 1,
) {
  const declared = normalizeScrollAxes(axes);
  if (!declared) {
    return null;
  }
  return declared.filter((axis) =>
    axis === SCROLL_AXIS.VERTICAL
      ? hasVerticalScrollOverflow(element, tolerance)
      : hasHorizontalScrollOverflow(element, tolerance),
  );
}

export function scrollBackToTop(scrollport: Element) {
  const reduceMotion = globalThis.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  scrollport.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}
