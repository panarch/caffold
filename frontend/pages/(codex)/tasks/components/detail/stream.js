import { taskStreamUrl } from "../../../../../api.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
} from "../../runtime-state.js";

const STREAM_ERROR_DELAY_MS = 8_000;

export class TaskDetailStream {
  constructor(callbacks = {}) {
    this.onTaskSync = callbacks.onTaskSync ?? (() => {});
    this.onTaskEvent = callbacks.onTaskEvent ?? (() => {});
    this.onRefresh = callbacks.onRefresh ?? (() => Promise.resolve());
    this.onStateChange = callbacks.onStateChange ?? (() => {});
    this.threadId = "";
    this.stream = null;
    this.state = TASK_TRANSPORT_STATE.IDLE;
    this.generation = 0;
    this.errorTimer = null;
    this.refresh = null;
    this.visibilityListenerAttached = false;
    this.boundVisibilityChange = () => this.visibilityChanged();
  }

  activate(threadId, { force = false } = {}) {
    const nextThreadId = `${threadId ?? ""}`.trim();
    if (
      !force &&
      this.threadId === nextThreadId &&
      (this.stream || document.visibilityState !== "visible")
    ) {
      return;
    }

    this.closeConnection();
    this.threadId = nextThreadId;
    if (!nextThreadId) {
      this.detachVisibilityListener();
      return;
    }

    this.attachVisibilityListener();
    if (document.visibilityState !== "visible") {
      return;
    }
    this.openConnection(nextThreadId, this.generation);
  }

  openConnection(threadId, generation) {
    if (
      this.stream ||
      document.visibilityState !== "visible" ||
      !this.isCurrentGeneration(threadId, generation)
    ) {
      return;
    }
    if (!("EventSource" in window)) {
      this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }

    let stream;
    try {
      stream = new EventSource(taskStreamUrl(threadId));
    } catch {
      this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }

    this.stream = stream;
    this.setState(TASK_TRANSPORT_STATE.CONNECTING, { notify: false });
    stream.addEventListener("open", () => {
      if (!this.isCurrent(stream, threadId, generation)) {
        return;
      }
      const shouldRefresh = isTaskTransportStale(this.state);
      this.clearErrorTimer();
      if (shouldRefresh) {
        this.requestRefresh(threadId, generation);
        return;
      }
      this.setState(TASK_TRANSPORT_STATE.READY);
    });
    stream.addEventListener("error", () => {
      if (!this.isCurrent(stream, threadId, generation)) {
        return;
      }
      this.clearErrorTimer();
      if (stream.readyState === 2) {
        this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
        return;
      }
      this.setState(TASK_TRANSPORT_STATE.RECONNECTING);
      this.errorTimer = window.setTimeout(() => {
        if (
          this.isCurrent(stream, threadId, generation) &&
          this.state === TASK_TRANSPORT_STATE.RECONNECTING
        ) {
          this.errorTimer = null;
          this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
        }
      }, STREAM_ERROR_DELAY_MS);
    });
    stream.addEventListener("task-sync", (event) => {
      if (!this.isCurrent(stream, threadId, generation)) {
        return;
      }
      const message = parseJson(event.data);
      if (
        message?.reason === "external-sync-start" ||
        message?.threadId !== threadId
      ) {
        return;
      }
      this.onTaskSync(message);
    });
    stream.addEventListener("task-event", (event) => {
      if (!this.isCurrent(stream, threadId, generation)) {
        return;
      }
      const message = parseJson(event.data);
      if (message?.threadId !== threadId) {
        return;
      }
      this.onTaskEvent(message);
    });
  }

  deactivate() {
    this.closeConnection();
    this.threadId = "";
    this.detachVisibilityListener();
  }

  requestRefresh(threadId = this.threadId, generation = this.generation) {
    if (!threadId || !this.isCurrentGeneration(threadId, generation)) {
      return Promise.resolve(null);
    }

    if (
      this.refresh?.threadId === threadId &&
      this.refresh?.generation === generation
    ) {
      this.refresh.dirty = true;
      return this.refresh.promise;
    }

    const refresh = {
      threadId,
      generation,
      dirty: false,
      promise: null,
    };
    refresh.promise = Promise.resolve()
      .then(() =>
        this.onRefresh(
          threadId,
          () => this.isCurrentGeneration(threadId, generation),
        ),
      )
      .catch(() => {
        if (
          this.isCurrentGeneration(threadId, generation) &&
          isTaskTransportStale(this.state)
        ) {
          this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
        }
      })
      .finally(() => {
        if (this.refresh !== refresh) {
          return;
        }
        const shouldRefreshAgain =
          refresh.dirty && this.isCurrentGeneration(threadId, generation);
        this.refresh = null;
        if (shouldRefreshAgain) {
          this.requestRefresh(threadId, generation);
        }
      });
    this.refresh = refresh;
    return refresh.promise;
  }

  visibilityChanged() {
    if (!this.threadId) {
      return;
    }
    if (document.visibilityState !== "visible") {
      this.closeConnection();
      return;
    }

    const threadId = this.threadId;
    const generation = this.generation;
    void this.requestRefresh(threadId, generation).finally(() => {
      this.openConnection(threadId, generation);
    });
  }

  markCanonicalReady(threadId) {
    if (
      threadId === this.threadId &&
      this.stream?.readyState === 1 &&
      isTaskTransportStale(this.state)
    ) {
      this.clearErrorTimer();
      this.setState(TASK_TRANSPORT_STATE.READY, { notify: false });
    }
  }

  markUnavailable(threadId, { notify = true } = {}) {
    if (threadId === this.threadId && isTaskTransportStale(this.state)) {
      this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE, { notify });
    }
  }

  closeConnection() {
    this.generation += 1;
    this.clearErrorTimer();
    this.stream?.close();
    this.stream = null;
    this.state = TASK_TRANSPORT_STATE.IDLE;
    this.refresh = null;
  }

  clearErrorTimer() {
    window.clearTimeout(this.errorTimer);
    this.errorTimer = null;
  }

  isCurrent(stream, threadId, generation) {
    return this.stream === stream && this.isCurrentGeneration(threadId, generation);
  }

  isCurrentGeneration(threadId, generation) {
    return this.threadId === threadId && this.generation === generation;
  }

  setState(state, { notify = true } = {}) {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    if (notify) {
      this.onStateChange(state, previousState);
    }
  }

  attachVisibilityListener() {
    if (this.visibilityListenerAttached) {
      return;
    }
    this.visibilityListenerAttached = true;
    document.addEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
  }

  detachVisibilityListener() {
    if (!this.visibilityListenerAttached) {
      return;
    }
    this.visibilityListenerAttached = false;
    document.removeEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
