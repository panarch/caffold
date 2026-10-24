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
}): KeyboardNavigationContext;

export function popoverScrollSurfaceScope(options: {
  id: string;
  label: string;
  popover: HTMLElement;
  isCurrent?: () => boolean;
}): ScrollSurfaceScope;
