// What TypeScript modules use from keyboard-navigation.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { KeyboardNavigationContext } from "./keyboard-navigation/context.js";

export {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
  popoverScrollSurfaceScope,
} from "./keyboard-navigation/context.js";

// What a surface dispatches when a keyboard session it holds ends on its own.
export const KEYBOARD_SESSION_DISMISS_EVENT: string;

// The one keyboard navigation over the app shell: Action Hints, scroll mode,
// the shortcut list, and the shell's key combinations.
export class KeyboardNavigationController {
  constructor(options: {
    workspace: HTMLElement;
    collectKeyboardNavigationContexts(): KeyboardNavigationContext[];
    shortcutDialog?: HTMLElement | null;
    afterActionHintActivation?(target: {
      id: string;
      actionId: string;
      control?: Element | null;
    }): void;
    openTaskSwitcher?(): boolean;
    toggleTerminal?(): boolean;
    toggleSidePane?(): boolean;
    readSettings?(): { actionHintsEnabled?: boolean };
  });
  readonly actionHints: object;
  connect(): void;
  disconnect(): void;
  routeWillChange(): void;
  cancelStoredMode(reason: string, options?: { restoreFocus?: boolean }): void;
}
