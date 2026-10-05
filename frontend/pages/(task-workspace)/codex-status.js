import {
  consumeCodexResetCredit,
  getCodexStatus,
  restartCodexRuntime,
  updateCodexRuntime,
} from "../../api.js";
import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
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
  resetCreditExpiry,
  formatUsedPercent,
} from "./codex-status/model.js";
import {
  CodexStatusLifecycle,
} from "./codex-status/lifecycle.js";

export const CODEX_STATUS_REFRESH_REQUEST_EVENT =
  "caffold:refresh-codex-status";
export const CODEX_RESET_CREDIT_REQUEST_EVENT =
  "caffold:request-codex-reset-credit";
export const CODEX_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-codex-runtime-restart";
export const CODEX_RUNTIME_UPDATE_REQUEST_EVENT =
  "caffold:request-codex-runtime-update";

export {
  INITIAL_CODEX_STATUS_SNAPSHOT,
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
  resetCreditExpiry,
  formatUsedPercent,
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
} = {}) {
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
