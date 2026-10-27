import type { TaskTransportState } from "../runtime-state.js";

export const TASK_DETAIL_TRANSPORT_CHANGE_EVENT =
  "caffold:task-detail-transport-change";

export interface TaskDetailTransportChangeDetail {
  state?: TaskTransportState;
}

declare global {
  interface HTMLElementEventMap {
    [TASK_DETAIL_TRANSPORT_CHANGE_EVENT]: CustomEvent<TaskDetailTransportChangeDetail>;
  }
}
