import {
  type ActionHintScope,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import {
  type ActionHintPull,
  normalizeMutationRootList,
} from "../action-hints.js";
import { ElementDeclarations } from "../element-declarations.js";
import {
  mergeScrollSurfaceScopes,
  normalizeScrollAxes,
  type ScrollAxis,
  type ScrollSurface,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
} from "../scroll-scope.js";
import type { CaffoldKeyboardNavigationPresentation } from "./components/presentation.js";

export type KeyboardNavigationContextKind = "workspace" | "modal" | "popover";

export interface KeyboardNavigationEditing {
  escapeTarget: (editable: Element) => Element | null;
}

/**
 * One place keyboard navigation works in: the workspace, or a modal or
 * popover over it. It shows its modes with its own presentation, offers its
 * Action Hints and Scroll surfaces, and names where Escape leaves an edited
 * control for.
 */
export interface KeyboardNavigationContext {
  id: string;
  kind: KeyboardNavigationContextKind;
  root: HTMLElement;
  presentation: CaffoldKeyboardNavigationPresentation;
  // Whether a session that opened it continues into it, `S` stays with
  // Scroll mode while its Action Hints are open, and dismissing a session
  // closes it.
  sessionBound: boolean;
  actionHints: ActionHintScope | null;
  scroll: ScrollSurfaceScope | null;
  editing: KeyboardNavigationEditing | null;
}

export type ContextScrollSurface = ScrollSurface & { axes: ScrollAxis[] };

export interface NormalizedKeyboardNavigationContext
  extends Omit<KeyboardNavigationContext, "scroll"> {
  scroll:
    | (Omit<ScrollSurfaceScope, "surfaces" | "resizeElements"> & {
        surfaces: ContextScrollSurface[];
        resizeElements: Element[];
      })
    | null;
}

export interface KeyboardContextDeclaration {
  id: string;
  sessionBound?: boolean;
  // Whether it is a keyboard context now. Left out, it is.
  when?: boolean;
}

// A popover is also a Scroll surface of its own, with this label.
export interface PopoverContextDeclaration extends KeyboardContextDeclaration {
  label: string;
}

export interface KeyboardContextCapabilities {
  // Goes in front of each declared context id, as a parent's scope id does.
  scopeId?: string;
  actionHints?: (pull: ActionHintPull) => ActionHintScope;
  scroll?: (pull: ScrollSurfacePull) => ScrollSurfaceScope;
  editing?: KeyboardNavigationEditing;
}

type DeclaredContext =
  | { kind: "modal"; declaration: KeyboardContextDeclaration }
  | { kind: "popover"; declaration: PopoverContextDeclaration };

/**
 * The keyboard contexts one component declares in its template: its modals
 * and popovers, and the presentation host inside each.
 *
 * `contexts()` makes one context for each root that is open. The context id
 * goes in front of its target and surface ids, and the root clips them and
 * scrolls them.
 */
export class KeyboardContexts {
  private readonly owner: HTMLElement;
  private readonly roots: ElementDeclarations<DeclaredContext>;
  private readonly presentations: ElementDeclarations<null>;

  constructor(owner: HTMLElement) {
    this.owner = owner;
    this.roots = new ElementDeclarations(owner, { contextRoots: true });
    this.presentations = new ElementDeclarations(owner);
  }

  modal(declaration: KeyboardContextDeclaration) {
    return this.roots.on({ kind: "modal", declaration });
  }

  popover(declaration: PopoverContextDeclaration) {
    return this.roots.on({ kind: "popover", declaration });
  }

  presentation() {
    return this.presentations.on(null);
  }

  contexts(
    capabilities: KeyboardContextCapabilities = {},
  ): KeyboardNavigationContext[] {
    return this.roots.all().flatMap(({ element, value }) => {
      const root = element as HTMLElement;
      const open =
        value.kind === "modal"
          ? root.matches(":modal")
          : root.matches(":popover-open");
      if (!open || value.declaration.when === false) {
        return [];
      }
      const id = capabilities.scopeId
        ? `${capabilities.scopeId}:${value.declaration.id}`
        : value.declaration.id;
      const pull = { scopeId: id, clipRoots: [root], contextRoot: root };
      const actionHints = capabilities.actionHints?.(pull);
      const scroll = [
        value.kind === "popover"
          ? popoverScrollSurfaceScope(id, value.declaration.label, root)
          : null,
        capabilities.scroll?.(pull),
      ].filter((scope) => scope != null);
      return this.context({
        id,
        kind: value.kind,
        root,
        contextRoot: root,
        actionHints:
          actionHints &&
          mergeActionHintScopes(actionHints, { scrollRoots: [root] }),
        sessionBound: value.declaration.sessionBound ?? false,
        scroll: scroll.length ? mergeScrollSurfaceScopes(...scroll) : null,
        editing: capabilities.editing,
      });
    });
  }

  workspace(
    id: string,
    { actionHints, scroll, editing }: KeyboardContextCapabilities = {},
  ): KeyboardNavigationContext[] {
    const pull = { contextRoot: null };
    return this.context({
      id,
      kind: "workspace",
      root: this.owner,
      contextRoot: null,
      actionHints: actionHints?.(pull),
      sessionBound: false,
      scroll: scroll?.(pull),
      editing,
    });
  }

  private context({
    id,
    kind,
    root,
    contextRoot,
    actionHints,
    sessionBound,
    scroll,
    editing,
  }: {
    id: string;
    kind: KeyboardNavigationContextKind;
    root: HTMLElement;
    contextRoot: Element | null;
    actionHints: ActionHintScope | undefined;
    sessionBound: boolean;
    scroll: ScrollSurfaceScope | null | undefined;
    editing?: KeyboardNavigationEditing;
  }): KeyboardNavigationContext[] {
    const [entry] = this.presentations.list(contextRoot);
    if (!entry) {
      return [];
    }
    return [
      {
        id,
        kind,
        root,
        presentation: entry.element as CaffoldKeyboardNavigationPresentation,
        sessionBound,
        actionHints: actionHints ?? null,
        scroll: scroll ?? null,
        editing: editing ?? null,
      },
    ];
  }
}

export function mergeKeyboardNavigationContexts(
  ...collections: Array<KeyboardNavigationContext[] | null | undefined>
): KeyboardNavigationContext[] {
  return collections.flatMap((collection) => collection ?? []);
}

// Null when any one context is malformed, so the coordinator keeps none.
export function normalizeKeyboardNavigationContexts(
  contexts: readonly KeyboardNavigationContext[],
): NormalizedKeyboardNavigationContext[] | null {
  const ids = new Set<string>();
  const roots = new Set<Element>();
  const normalized: NormalizedKeyboardNavigationContext[] = [];
  for (const context of contexts) {
    const id = context.id.trim();
    if (
      !id ||
      ids.has(id) ||
      roots.has(context.root) ||
      !context.root.contains(context.presentation)
    ) {
      return null;
    }
    const actionHints = context.actionHints
      ? normalizeActionHintScope(context.actionHints)
      : null;
    const scroll = context.scroll
      ? normalizeScrollScope(context.scroll, context.root)
      : null;
    if (
      (context.actionHints && !actionHints) ||
      (context.scroll && !scroll) ||
      (!actionHints && !scroll && !context.editing)
    ) {
      return null;
    }
    ids.add(id);
    roots.add(context.root);
    normalized.push({ ...context, id, actionHints, scroll });
  }
  return normalized;
}

function popoverScrollSurfaceScope(
  id: string,
  label: string,
  popover: HTMLElement,
): ScrollSurfaceScope {
  return {
    blocked: false,
    surfaces: [{ id, label, scrollport: popover, clipRoots: [popover] }],
    mutationRoots: [popover],
    resizeElements: [popover],
    scrollRoots: [popover],
  };
}

function normalizeActionHintScope(scope: ActionHintScope) {
  const mutationRoots = normalizeMutationRootList(scope.mutationRoots);
  return mutationRoots
    ? {
        blocked: scope.blocked,
        targets: [...scope.targets],
        mutationRoots,
        scrollRoots: uniqueElements(scope.scrollRoots),
      }
    : null;
}

function normalizeScrollScope(scope: ScrollSurfaceScope, root: HTMLElement) {
  const mutationRoots = normalizeMutationRootList([
    root,
    ...scope.mutationRoots,
  ]);
  const surfaces = normalizeSurfaces(scope.surfaces);
  return mutationRoots && surfaces
    ? {
        blocked: scope.blocked,
        surfaces,
        mutationRoots,
        resizeElements: uniqueElements([root, ...scope.resizeElements]),
        scrollRoots: uniqueElements(scope.scrollRoots),
      }
    : null;
}

function normalizeSurfaces(surfaces: readonly ScrollSurface[]) {
  const ids = new Set<string>();
  const normalized: ContextScrollSurface[] = [];
  for (const surface of surfaces) {
    const id = surface.id.trim();
    const label = surface.label.trim();
    const axes = normalizeScrollAxes(surface.axes);
    if (!id || ids.has(id) || !label || !axes) {
      return null;
    }
    ids.add(id);
    normalized.push({
      ...surface,
      id,
      label,
      axes,
      clipRoots: uniqueElements(surface.clipRoots),
    });
  }
  return normalized;
}

function uniqueElements(elements: readonly Element[]) {
  return [...new Set(elements)];
}
