import {
  consumeCodexResetCredit,
  getCodexStatus,
  restartCodexRuntime,
  updateCodexRuntime,
} from "../../api.js";
import {
  CodexStatusLifecycle,
  type CodexStatusLifecycleOptions,
} from "./codex-status/lifecycle.js";
import {
  codexBlocksTaskOperations,
  codexRateWindows,
  codexResetCredits,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  codexState,
  createCodexStatusSnapshot,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatResetCredits,
  formatUsedPercent,
  INITIAL_CODEX_STATUS_SNAPSHOT,
  resetCreditExpiry,
} from "./codex-status/model.js";

export type { CodexResetCreditRequestState } from "./codex-status/lifecycle.js";
export type {
  CodexRuntimeRequestState,
  CodexStatusSnapshot,
} from "./codex-status/model.js";

export const CODEX_STATUS_REFRESH_REQUEST_EVENT =
  "caffold:refresh-codex-status";
export const CODEX_RESET_CREDIT_REQUEST_EVENT =
  "caffold:request-codex-reset-credit";
export const CODEX_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-codex-runtime-restart";
export const CODEX_RUNTIME_UPDATE_REQUEST_EVENT =
  "caffold:request-codex-runtime-update";

export {
  codexBlocksTaskOperations,
  codexRateWindows,
  codexResetCredits,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  codexState,
  createCodexStatusSnapshot,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatResetCredits,
  formatUsedPercent,
  INITIAL_CODEX_STATUS_SNAPSHOT,
  resetCreditExpiry,
};

export function createCodexStatusLifecycle({
  consumeResetCredit = consumeCodexResetCredit,
  loadStatus = getCodexStatus,
  onResetCreditStateChange,
  onRestartStateChange,
  onRuntimeActionChange,
  onSnapshotChange,
  onUpdateStateChange,
  restartRuntime = restartCodexRuntime,
  updateRuntime = updateCodexRuntime,
}: Partial<CodexStatusLifecycleOptions> = {}) {
  return new CodexStatusLifecycle({
    consumeResetCredit,
    loadStatus,
    onResetCreditStateChange,
    onRestartStateChange,
    onRuntimeActionChange,
    onSnapshotChange,
    onUpdateStateChange,
    restartRuntime,
    updateRuntime,
  });
}
