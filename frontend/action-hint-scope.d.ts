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

export function emptyActionHintScope(): ActionHintScope;

export function buttonActionHintTarget(options: {
  id: string;
  actionId: string;
  label: string;
  invalidationOwner: Element;
  control: HTMLElement;
  anchor?: Element;
  clipRoots: Element[];
  badgeAtEnd?: boolean;
  isActionable: () => boolean;
}): ActionHintTarget;

export function mergeActionHintScopes(
  ...scopes: Array<ActionHintScope | null | undefined>
): ActionHintScope;
