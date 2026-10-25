// What TypeScript modules use from codex-status.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export interface CodexExecutable {
  path?: string | null;
  version?: string | null;
}

export interface CodexReadiness {
  state: string;
  blocksTaskOperations?: boolean;
  reasonCode?: string | null;
  diagnosticMessage?: string | null;
  minimumSupportedVersion?: string | null;
  detectedExecutable?: CodexExecutable | null;
  managedExecutable?: CodexExecutable | null;
  runningAppServerVersion?: string | null;
}

export interface CodexRateWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexResetCredit {
  id?: string | null;
  title?: string | null;
  expiresAt?: number | null;
  status?: string;
}

export interface CodexStatus {
  readiness?: CodexReadiness | null;
  account?: {
    accountType?: string;
    email?: string | null;
    planType?: string | null;
  } | null;
  diagnostics?: { processConnected?: boolean } | null;
}

export interface CodexStatusSnapshot {
  phase: "checking" | "loaded" | "failed";
  status: CodexStatus | null;
  error: string;
}

export const CODEX_STATUS_REFRESH_REQUEST_EVENT: string;
export const CODEX_RESET_CREDIT_REQUEST_EVENT: string;
export const CODEX_RUNTIME_RESTART_REQUEST_EVENT: string;
export const CODEX_RUNTIME_UPDATE_REQUEST_EVENT: string;

type Status = CodexStatus | null | undefined;

// A snapshot with each field left out at its resting value.
export function createCodexStatusSnapshot(
  snapshot?: Partial<CodexStatusSnapshot>,
): CodexStatusSnapshot;

// What Codex's readiness means for the surfaces that use it: not known yet,
// ready, needing the person, or out of reach.
export function codexState(
  snapshot: CodexStatusSnapshot | null | undefined,
): "pending" | "available" | "attention" | "unavailable";

export function codexBlocksTaskOperations(status: Status): boolean;

export function codexRateWindows(status: Status): Array<{
  limitId?: string;
  limitName?: string;
  name: "primary" | "secondary";
  window: CodexRateWindow;
}>;

export function codexResetCredits(status: Status): {
  availableCount: number;
  credits: CodexResetCredit[] | null;
} | null;

export function codexRuntimeRestartAvailable(status: Status): boolean;

export function codexRuntimeUpdateAvailable(status: Status): boolean;

export function formatCodexAccount(status: Status): string;

export function formatCodexPlan(status: Status): string;

export function formatCodexReadiness(
  snapshot: CodexStatusSnapshot | null | undefined,
): string;

export function formatRateReset(
  window: CodexRateWindow | null | undefined,
): string;

export function formatRateWindowLabel(
  window: CodexRateWindow | null | undefined,
  name: string,
): string;

export function formatResetCredits(status: Status): string;

export function formatUsedPercent(
  window: CodexRateWindow | null | undefined,
): string;

export function resetCreditExpiry(
  expiresAt: unknown,
): { datetime: string; label: string } | null;
