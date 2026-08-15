import { taskStreamUrl } from "../../../../../api.js";
import { TaskStreamLifecycle } from "../../stream.js";

export class TaskDetailStream {
  constructor(callbacks = {}) {
    this.onTaskSync = callbacks.onTaskSync ?? (() => {});
    this.onTaskEvent = callbacks.onTaskEvent ?? (() => {});
    this.transport = new TaskStreamLifecycle({
      createUrl: (threadId) => taskStreamUrl(threadId),
      eventTypes: ["task-sync", "task-event"],
      onEvent: (type, event, threadId) =>
        this.handleEvent(type, event, threadId),
      onReconcile: callbacks.onRefresh ?? (() => Promise.resolve()),
      onStateChange: callbacks.onStateChange ?? (() => {}),
    });
  }

  get threadId() {
    return this.transport.contextKey;
  }

  get stream() {
    return this.transport.source;
  }

  get state() {
    return this.transport.state;
  }

  get generation() {
    return this.transport.generation;
  }

  get refresh() {
    return this.transport.reconciliation;
  }

  activate(threadId, options = {}) {
    this.transport.activate(threadId, options);
  }

  deactivate() {
    this.transport.deactivate();
  }

  suspend() {
    this.transport.suspend();
  }

  recover(threadId = this.threadId) {
    return this.transport.recover(threadId);
  }

  requestRefresh(threadId = this.threadId, generation = this.generation) {
    return this.transport.requestReconciliation(threadId, generation);
  }

  handleEvent(type, event, threadId) {
    const message = parseJson(event.data);
    if (message?.threadId !== threadId) {
      return;
    }
    if (type === "task-sync") {
      if (message.reason !== "external-sync-start") {
        this.onTaskSync(message);
      }
      return;
    }
    this.onTaskEvent(message);
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
