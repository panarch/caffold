// What TypeScript modules use from context.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { ActionHintScope } from "../action-hint-scope.js";

export type KeyboardNavigationContextKind = "workspace" | "modal" | "popover";

export interface KeyboardNavigationContext {
  id: string;
  kind: KeyboardNavigationContextKind;
  root: Element;
  actionHints?: {
    dialog: HTMLElement;
    scope: ActionHintScope;
    sessionBound: boolean;
  };
}

export function keyboardNavigationContext(options: {
  id: string;
  kind: KeyboardNavigationContextKind;
  root: Element;
  actionHints?: {
    dialog: HTMLElement;
    scope: ActionHintScope;
    sessionBound?: boolean;
  } | null;
}): KeyboardNavigationContext;
