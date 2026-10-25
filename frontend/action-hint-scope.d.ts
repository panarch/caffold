// What TypeScript modules use from action-hint-scope.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export interface ActionHintScopeOptions {
  scopeId?: string;
  actionId?: string;
  clipRoots?: Element[];
}

export interface ActionHintTarget {
  id: string;
  actionId: string;
  label: string;
  invalidationOwner: Element;
  controlKind: string;
  control: HTMLElement;
  anchor: Element;
  clipRoots: Element[];
  badgeAtEnd: boolean;
  activationKey?: string;
  isActionable: () => boolean;
  activate: () => void;
}

export interface ActionHintScope {
  blocked: boolean;
  targets: ActionHintTarget[];
  mutationRoots: Node[];
  scrollRoots: Element[];
}

interface ActionHintTargetOptions {
  id: string;
  actionId: string;
  label: string;
  invalidationOwner: Element;
  control: HTMLElement;
  anchor?: Element;
  clipRoots: Element[];
  isActionable: () => boolean;
}

export interface LinkActionHintBinding {
  readonly href: string | null;
  readonly target: string | null;
  readonly rel: string | null;
}

export function emptyActionHintScope(): ActionHintScope;

export function buttonActionHintTarget(
  options: ActionHintTargetOptions & { badgeAtEnd?: boolean },
): ActionHintTarget;

export function disclosureActionHintTarget(
  options: ActionHintTargetOptions,
): ActionHintTarget;

export function linkActionHintTarget(
  options: ActionHintTargetOptions,
): ActionHintTarget;

export function selectActionHintTarget(
  options: ActionHintTargetOptions,
): ActionHintTarget;

export function separatorActionHintTarget(
  options: ActionHintTargetOptions,
): ActionHintTarget;

// A reorder handle the key focuses rather than presses, so arrow keys can
// move its item from there.
export function reorderHandleActionHintTarget(
  options: ActionHintTargetOptions,
): ActionHintTarget;

export function linkActionHintLabel(control: Element): string;

export function captureLinkActionHintBinding(
  control: Element,
): LinkActionHintBinding;

export function matchesLinkActionHintBinding(
  control: Element,
  binding: LinkActionHintBinding,
): boolean;

export function hasActionHintLayoutBox(
  element: Element | null | undefined,
): boolean;

export function mergeActionHintScopes(
  ...scopes: Array<ActionHintScope | null | undefined>
): ActionHintScope;
