// What TypeScript modules use from scroll-scope.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export type ScrollAxis = "vertical" | "horizontal";

export interface ScrollSurface {
  id: string;
  label: string;
  scrollport: Element;
  axes?: ScrollAxis[];
  clipRoots: Element[];
  isEligible: () => boolean;
}

export interface ScrollSurfaceScope {
  blocked: boolean;
  surfaces: ScrollSurface[];
  mutationRoots: Node[];
  resizeElements: Element[];
  scrollRoots: Element[];
}

export interface ScrollSurfaceScopeOptions {
  scopeId?: string;
  label?: string;
  clipRoots?: Element[];
  isCurrent?: () => boolean;
}

export function emptyScrollSurfaceScope(): ScrollSurfaceScope;

export function mergeScrollSurfaceScopes(
  ...scopes: Array<ScrollSurfaceScope | null | undefined>
): ScrollSurfaceScope;

export function hasScrollLayoutBox(
  element: Element | null | undefined,
): boolean;

export function scrollBackToTop(scrollport: Element): void;
