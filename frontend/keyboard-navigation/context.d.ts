// What TypeScript modules use from context.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { ActionHintScope } from "../action-hint-scope.js";
import type { ScrollSurfaceScope } from "../scroll-scope.js";

export type KeyboardNavigationContextKind = "workspace" | "modal" | "popover";

export interface KeyboardNavigationScroll {
  hud: HTMLElement;
  selector: HTMLElement;
  scope: ScrollSurfaceScope;
}

// Where Escape moves focus from a control that is being edited.
export interface KeyboardNavigationEditing {
  escapeTarget?: (editable: Element) => Element | null;
}

export interface KeyboardNavigationContext {
  id: string;
  kind: KeyboardNavigationContextKind;
  root: Element;
  actionHints?: {
    dialog: HTMLElement;
    scope: ActionHintScope;
    sessionBound: boolean;
  };
  scroll?: KeyboardNavigationScroll;
  editing?: KeyboardNavigationEditing;
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
  scroll?: KeyboardNavigationScroll | null;
  editing?: KeyboardNavigationEditing | null;
}): KeyboardNavigationContext;

export function mergeKeyboardNavigationContexts(
  ...collections: Array<KeyboardNavigationContext[] | null | undefined>
): KeyboardNavigationContext[];

export function popoverScrollSurfaceScope(options: {
  id: string;
  label: string;
  popover: HTMLElement;
  isCurrent?: () => boolean;
}): ScrollSurfaceScope;
