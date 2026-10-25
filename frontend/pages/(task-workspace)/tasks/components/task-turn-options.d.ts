// What TypeScript modules use from task-turn-options.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { ActionHintTarget } from "#app/action-hint-scope.js";
import type { keyboardNavigationContext } from "#app/keyboard-navigation.js";

export interface TurnOptionsSelection {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
}

export interface TurnOptionsContext {
  cwd?: string;
  initialSelection?: TurnOptionsSelection;
  locked?: boolean;
  placement?: "above" | "below";
  provider?: string;
}

// What a turn started now would run under.
export interface TurnSubmissionOptions {
  model?: string;
  provider?: string;
  effort?: string;
  fastMode: boolean;
  permissionMode?: string;
}

export interface CaffoldTaskTurnOptions extends HTMLElement {
  reset(context?: TurnOptionsContext): void;
  setContext(context?: TurnOptionsContext): boolean;
  readyForSubmission(): boolean;
  submissionOptions(): TurnSubmissionOptions;
  resetFastMode(): void;
  hidePopovers(): void;
  actionHintModelTarget(options: {
    scopeId: string;
    clipRoots?: Element[];
  }): ActionHintTarget | null;
  actionHintPermissionTarget(options: {
    scopeId: string;
    clipRoots?: Element[];
  }): ActionHintTarget | null;
  keyboardNavigationContexts(options?: {
    scopeId?: string;
  }): ReturnType<typeof keyboardNavigationContext>[];
}
