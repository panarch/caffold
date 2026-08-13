import {
  getCodexStatus,
  restartCodexRuntime,
  retryTaskStoreMigration,
} from "../../api.js";
import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  PENDING_CODEX_TASK_OPERATIONS,
  codexBlocksTaskOperations,
  codexState,
  codexTaskRecoveryVisible,
  codexTaskOperationsPresentation,
  createCodexStatusSnapshot,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
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
  PENDING_CODEX_TASK_OPERATIONS,
  codexBlocksTaskOperations,
  codexState,
  codexTaskRecoveryVisible,
  codexTaskOperationsPresentation,
  createCodexStatusSnapshot,
  CodexStatusLifecycle,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
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
