import {
  getCodexStatus,
  restartCodexRuntime,
  retryTaskStoreMigration,
} from "../../api.js";
import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexBlocksTaskOperations,
  codexRuntimeRestartAvailable,
  codexSetupVisible,
  codexState,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
  taskStoreRecoveryVisible,
} from "./codex-status/model.js";
import {
  CodexStatusLifecycle,
} from "./codex-status/lifecycle.js";

export const CODEX_STATUS_REFRESH_REQUEST_EVENT =
  "caffold:refresh-codex-status";
export const CODEX_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-codex-runtime-restart";

export {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexBlocksTaskOperations,
  codexRuntimeRestartAvailable,
  codexSetupVisible,
  codexState,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
  taskStoreRecoveryVisible,
};

export function createCodexStatusLifecycle({
  loadStatus = getCodexStatus,
  onRestartStateChange,
  onSnapshotChange,
  restartRuntime = restartCodexRuntime,
  retryTaskStore = retryTaskStoreMigration,
} = {}) {
  return new CodexStatusLifecycle({
    loadStatus,
    onRestartStateChange,
    onSnapshotChange,
    restartRuntime,
    retryTaskStore,
  });
}
