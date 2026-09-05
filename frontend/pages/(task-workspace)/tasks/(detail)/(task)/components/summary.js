import { escapeHtml } from "../../../../../../components/dom.js";
import { taskThreadId } from "../../../task-list-model.js";
import "./summary/components/info.js";

class CaffoldTaskDetailSummary extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener(
      "caffold:task-detail-info-intent",
      this.boundInfoIntent,
    );
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener(
      "caffold:task-detail-info-intent",
      this.boundInfoIntent,
    );
    this.deactivate();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      task: null,
      canonicalTaskAvailable: false,
      archiveBlockedByActive: false,
      transportState: "idle",
      contextPath: ".",
      provider: "",
      archiveState: { loading: false, error: null },
      forkState: { loading: false, error: null },
    };
    this.renderedThreadId = "";
    this.boundInfoIntent = (event) => this.handleInfoIntent(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const previousThreadId = taskThreadId(this.snapshot.task);
    const task = snapshot.task ?? null;
    const nextThreadId = taskThreadId(task);
    this.snapshot = {
      task,
      canonicalTaskAvailable: Boolean(snapshot.canonicalTaskAvailable),
      archiveBlockedByActive: Boolean(snapshot.archiveBlockedByActive),
      transportState: snapshot.transportState ?? "idle",
      contextPath: `${snapshot.contextPath ?? "."}`,
      provider: `${snapshot.provider ?? ""}`,
      archiveState: {
        loading: Boolean(snapshot.archiveState?.loading),
        error: snapshot.archiveState?.error ?? null,
      },
      forkState: {
        loading: Boolean(snapshot.forkState?.loading),
        error: snapshot.forkState?.error ?? null,
      },
    };
    if (
      nextThreadId &&
      previousThreadId === nextThreadId &&
      this.renderedThreadId === nextThreadId
    ) {
      this.patch();
    } else {
      this.render();
    }
  }

  deactivate() {
    this.taskInfo()?.deactivate();
  }

  actionHintScope(options = {}) {
    return this.taskInfo()?.actionHintScope(options) ?? { targets: [] };
  }

  keyboardNavigationContexts(options = {}) {
    return this.taskInfo()?.keyboardNavigationContexts(options) ?? [];
  }

  handleInfoIntent(event) {
    if (
      event.target !== this.taskInfo() ||
      !["archive", "fork"].includes(event.detail?.type)
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-summary-intent", {
        bubbles: true,
        composed: true,
        detail: { type: event.detail.type },
      }),
    );
  }

  render() {
    this.ensureState();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      this.renderedThreadId = "";
      return;
    }
    this.innerHTML = `
      <div class="task-detail-heading">
        <h2 title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</h2>
      </div>
      <div class="task-detail-right">
        <caffold-task-detail-info></caffold-task-detail-info>
      </div>
    `;
    this.renderedThreadId = taskThreadId(task);
    this.syncTaskInfo();
  }

  patch() {
    const task = this.snapshot.task;
    const heading = this.querySelector(".task-detail-heading h2");
    if (!task || !heading || !this.taskInfo()) {
      this.render();
      return;
    }
    if (heading.textContent !== `${task.title ?? ""}`) {
      heading.textContent = `${task.title ?? ""}`;
    }
    heading.title = `${task.title ?? ""}`;
    this.syncTaskInfo();
  }

  syncTaskInfo() {
    this.taskInfo()?.setSnapshot({
      task: this.snapshot.task,
      canonicalTaskAvailable: this.snapshot.canonicalTaskAvailable,
      archiveBlockedByActive: this.snapshot.archiveBlockedByActive,
      transportState: this.snapshot.transportState,
      contextPath: this.snapshot.contextPath,
      provider: this.snapshot.provider,
      archiveState: this.snapshot.archiveState,
      forkState: this.snapshot.forkState,
    });
  }

  taskInfo() {
    return this.querySelector("caffold-task-detail-info");
  }
}

if (!customElements.get("caffold-task-detail-summary")) {
  customElements.define(
    "caffold-task-detail-summary",
    CaffoldTaskDetailSummary,
  );
}
