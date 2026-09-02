import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../components/icons.js";
import { formatTaskStatus } from "../../../../../runtime-state.js";
import { shortId } from "../../../../../task-format.js";
import { taskThreadId } from "../../../../../task-list-model.js";
import {
  patchTaskStatusChip,
  renderTaskStatusChip,
} from "../../../../../components/task-status.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../../../action-hints.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../../../../../../keyboard-navigation.js";
import "../../../../../../../../keyboard-navigation/components/presentation.js";
import "./info/components/actions.js";

let taskInfoInstanceId = 0;

class CaffoldTaskDetailInfo extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener(
        "caffold:task-detail-info-action-intent",
        this.boundActionIntent,
      );
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    if (this.snapshot.task) {
      if (this.infoButton()) {
        this.patchStatus();
      } else {
        this.render();
      }
    }
  }

  disconnectedCallback() {
    this.deactivate();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener(
      "caffold:task-detail-info-action-intent",
      this.boundActionIntent,
    );
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    taskInfoInstanceId += 1;
    this.popoverId = `task-detail-info-${taskInfoInstanceId}`;
    this.renderedThreadId = "";
    this.renderedStatusKey = "";
    this.snapshot = normalizedSnapshot();
    this.listenersAttached = false;
    this.boundActionIntent = (event) => this.handleActionIntent(event);
    this.boundIconsReady = () => this.patchStatus();
    warmIcons();
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const nextSnapshot = normalizedSnapshot(snapshot);
    const nextThreadId = taskThreadId(nextSnapshot.task);
    this.snapshot = nextSnapshot;

    if (
      !nextThreadId ||
      nextThreadId !== this.renderedThreadId ||
      !this.infoButton()
    ) {
      this.render();
      return;
    }
    this.patch();
  }

  deactivate() {
    const popover = this.infoPopover();
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  handleActionIntent(event) {
    if (
      event.target !== this.actions() ||
      !["archive", "fork"].includes(event.detail?.type)
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-info-intent", {
        bubbles: true,
        composed: true,
        detail: { type: event.detail.type },
      }),
    );
  }

  render() {
    this.deactivate();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      this.renderedThreadId = "";
      this.renderedStatusKey = "";
      return;
    }

    this.innerHTML = `
      <button
        type="button"
        class="task-detail-info-button"
        popovertarget="${this.popoverId}"
      ></button>
      <div
        id="${this.popoverId}"
        class="task-detail-popover"
        popover="auto"
        aria-label="Task details"
      >
        <dl>
          <div>
            <dt>Task</dt>
            <dd data-task-info-field="task"></dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd data-task-info-field="status"></dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd data-task-info-field="thread"></dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd data-task-info-field="working-directory"></dd>
          </div>
          <div data-task-info-worktree>
            <dt>Worktree</dt>
            <dd data-task-info-field="worktree-path"></dd>
          </div>
          <div data-task-info-worktree>
            <dt>Branch</dt>
            <dd data-task-info-field="worktree-ref"></dd>
          </div>
        </dl>
        <caffold-task-detail-info-actions></caffold-task-detail-info-actions>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </div>
    `;
    this.renderedThreadId = taskThreadId(task);
    this.renderedStatusKey = "";
    this.patch();
  }

  patch() {
    const task = this.snapshot.task;
    if (!task || !this.infoButton()) {
      return;
    }

    this.patchStatus();
    setText(
      this.querySelector('[data-task-info-field="task"]'),
      `${task.title ?? ""}`,
    );
    setText(
      this.querySelector('[data-task-info-field="thread"]'),
      taskThreadId(task),
    );
    setText(
      this.querySelector('[data-task-info-field="working-directory"]'),
      `${task.cwdPath || task.cwd || this.snapshot.contextPath}`,
    );

    const hasWorktree = Boolean(task.worktree);
    for (const row of this.querySelectorAll("[data-task-info-worktree]")) {
      row.hidden = !hasWorktree;
    }
    setText(
      this.querySelector('[data-task-info-field="worktree-path"]'),
      `${task.worktree?.rootPath ?? ""}`,
    );
    setText(
      this.querySelector('[data-task-info-field="worktree-ref"]'),
      taskWorktreeRef(task),
    );
    this.actions()?.setSnapshot(this.snapshot);
  }

  patchStatus() {
    const task = this.snapshot.task;
    const button = this.infoButton();
    if (!task || !button) {
      return;
    }

    const statusLabel = formatTaskStatus(task);
    const status = renderTaskStatusChip(task, "task-detail-status", {
      label: false,
    });
    const content =
      status || renderInlineIcon("Info", "Task details", "task-action-icon");
    const renderKey = JSON.stringify([statusLabel, content]);
    if (renderKey === this.renderedStatusKey) {
      return;
    }

    patchStatusContent(button, content);
    setAttribute(button, "aria-label", `Task details, ${statusLabel}`);
    setAttribute(button, "title", `Status: ${statusLabel}`);
    setText(
      this.querySelector('[data-task-info-field="status"]'),
      statusLabel,
    );
    this.renderedStatusKey = renderKey;
  }

  actionHintScope({ scopeId = "task-detail", clipRoots = [] } = {}) {
    const threadId = taskThreadId(this.snapshot.task);
    const control = this.infoButton();
    const popover = this.infoPopover();
    if (!threadId || !scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: `${scopeId}:${threadId}:details:open`,
        actionId: ACTION_HINT_ACTION.TASK_DETAILS_OPEN,
        label: control.getAttribute("aria-label") || "Task details",
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          taskThreadId(this.snapshot.task) === threadId &&
          this.infoButton() === control &&
          this.infoPopover() === popover &&
          control.getAttribute("popovertarget") === popover.id &&
          !control.disabled &&
          !popover.matches(":popover-open"),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({ scopeId = "task-detail" } = {}) {
    const threadId = taskThreadId(this.snapshot.task);
    const popover = this.infoPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!threadId || !scopeId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:${threadId}:details`;
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: mergeActionHintScopes(
          this.actions()?.actionHintScope({
            scopeId: contextId,
            clipRoots: [popover],
          }),
          {
            mutationRoots: [popover],
            scrollRoots: [popover],
          },
        ),
      },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "Task details",
          popover,
          isCurrent: () =>
            this.isConnected &&
            taskThreadId(this.snapshot.task) === threadId &&
            this.infoPopover() === popover,
        }),
      },
    })];
  }

  infoButton() {
    return this.querySelector(".task-detail-info-button");
  }

  infoPopover() {
    return this.querySelector(".task-detail-popover");
  }

  actions() {
    return this.querySelector("caffold-task-detail-info-actions");
  }
}

if (!customElements.get("caffold-task-detail-info")) {
  customElements.define("caffold-task-detail-info", CaffoldTaskDetailInfo);
}

function normalizedSnapshot(snapshot = {}) {
  return {
    task: snapshot.task ?? null,
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
}

function taskWorktreeRef(task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  return branch || shortId(task?.worktree?.headSha ?? "");
}

function patchStatusContent(button, content) {
  const template = document.createElement("template");
  template.innerHTML = content.trim();
  const currentChip = button.querySelector(":scope > .task-status-chip");
  const nextChip = template.content.firstElementChild;
  if (currentChip && nextChip?.matches(".task-status-chip")) {
    patchTaskStatusChip(currentChip, nextChip);
    return;
  }
  if (button.innerHTML.trim() !== content.trim()) {
    button.innerHTML = content;
  }
}

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function setText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}
