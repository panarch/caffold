import {
  createTask,
  getTask,
  getTasks,
  interruptTask,
  resolveTaskApproval,
  sendTaskPrompt,
  taskStreamUrl,
} from "../../api.js";
import { escapeHtml } from "../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../components/icons.js";

class CaffoldTasksPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.view = "list";
    this.tasks = [];
    this.taskDetail = null;
    this.events = [];
    this.error = null;
    this.loading = false;
    this.project = null;
    this.projectId = "";
    this.selectedThreadId = "";
    this.stream = null;
    this.requestId = 0;
    this.newTaskDraft = { prompt: "" };
    this.followUpDraft = "";
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    this.addEventListener("click", (event) => {
      const action = event.target.closest("[data-task-action]");
      if (!action) {
        return;
      }

      this.handleAction(action.dataset.taskAction, action);
    });
    this.addEventListener("input", (event) => {
      const form = event.target.closest("form[data-task-form]");
      if (!form) {
        return;
      }

      this.captureDraft(form);
    });
    this.addEventListener(
      "submit",
      (event) => {
        const form = event.target.closest("form[data-task-form]");
        if (!form) {
          return;
        }

        event.preventDefault();
        this.handleForm(form.dataset.taskForm, form);
      },
      true,
    );
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.closeStream();
  }

  setProject(project) {
    this.ensureRendered();
    this.project = project ?? null;
    this.projectId = project?.id ?? "";
  }

  prepareRoute(route) {
    this.ensureRendered();
    const previousView = this.view;
    this.projectId = route?.projectId ?? this.projectId;
    this.error = null;
    if (route?.new) {
      if (previousView !== "new") {
        this.newTaskDraft = { prompt: "" };
      }
      this.view = "new";
      this.selectedThreadId = "";
      this.closeStream();
    } else if (route?.threadId) {
      this.view = "detail";
      this.selectedThreadId = route.threadId;
      this.taskDetail =
        this.taskDetail?.task?.threadId === route.threadId ? this.taskDetail : null;
    } else {
      this.view = "list";
      this.selectedThreadId = "";
      this.closeStream();
    }
    this.setAttribute("data-tasks-view", this.view);
    this.render();
  }

  async openRoute(route, options = {}) {
    this.setProject(options.project ?? this.project);
    this.prepareRoute(route);
    if (route?.new) {
      return this.openNew();
    }
    if (route?.threadId) {
      return await this.openTask(route.threadId);
    }
    return await this.openList();
  }

  async openList() {
    if (!this.projectId) {
      return null;
    }

    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    this.view = "list";
    this.render();

    try {
      const response = await getTasks(this.projectId);
      if (requestId !== this.requestId) {
        return null;
      }
      this.tasks = response.tasks ?? [];
      this.loading = false;
      this.render();
      return response;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loading = false;
      this.error = error;
      this.render();
      return null;
    }
  }

  openNew() {
    this.view = "new";
    this.error = null;
    this.loading = false;
    this.closeStream();
    this.render();
    this.querySelector("textarea[name='prompt']")?.focus();
    return null;
  }

  async openTask(threadId) {
    if (!threadId) {
      return null;
    }

    const requestId = ++this.requestId;
    this.view = "detail";
    this.selectedThreadId = threadId;
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const detail = await getTask(threadId, this.projectId);
      if (requestId !== this.requestId) {
        return null;
      }
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.loading = false;
      this.connectStream(threadId);
      this.render();
      return detail;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loading = false;
      this.error = error;
      this.render();
      return null;
    }
  }

  connectStream(threadId) {
    this.closeStream();
    if (!("EventSource" in window)) {
      return;
    }

    this.stream = new EventSource(taskStreamUrl(threadId, this.projectId));
    this.stream.addEventListener("task-event", (event) => {
      const entry = parseJson(event.data);
      if (!entry || entry.threadId !== this.selectedThreadId) {
        return;
      }
      this.events = upsertEvent(this.events, entry);
      this.refreshSelectedTask();
      this.render();
    });
  }

  closeStream() {
    this.stream?.close();
    this.stream = null;
  }

  async refreshSelectedTask() {
    if (!this.selectedThreadId) {
      return;
    }

    try {
      const detail = await getTask(this.selectedThreadId, this.projectId);
      if (detail?.task?.threadId !== this.selectedThreadId) {
        return;
      }
      this.taskDetail = detail;
      this.events = detail.events ?? this.events;
      this.render();
    } catch {
      // SSE already provided the timeline event. Keep the visible state stable.
    }
  }

  handleAction(action, element) {
    if (action === "open-list") {
      this.requestRoute({ kind: "tasks" });
      return;
    }
    if (action === "open-new") {
      this.requestRoute({ kind: "tasks", new: true });
      return;
    }
    if (action === "open-task") {
      this.requestRoute({ kind: "tasks", threadId: element.dataset.threadId });
      return;
    }
    if (action === "open-diff") {
      this.dispatchEvent(new CustomEvent("caffold:open-diff-workspace", { bubbles: true }));
      return;
    }
    if (action === "interrupt") {
      this.interruptSelectedTask();
      return;
    }
    if (action === "approval") {
      this.resolveApproval(element.dataset.approvalId, element.dataset.decision);
    }
  }

  async handleForm(formName, form) {
    if (formName === "create") {
      await this.createTaskFromForm(form);
      return;
    }
    if (formName === "follow-up") {
      await this.sendFollowUpFromForm(form);
    }
  }

  async createTaskFromForm(form) {
    this.captureDraft(form);
    const formData = new FormData(form);
    const prompt = `${formData.get("prompt") ?? ""}`.trim();
    if (!prompt || !this.projectId) {
      return;
    }

    this.loading = true;
    this.error = null;
    this.render();

    try {
      const detail = await createTask({
        projectId: this.projectId,
        prompt,
      });
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.tasks = upsertTask(this.tasks, detail.task);
      this.newTaskDraft = { prompt: "" };
      this.requestRoute({ kind: "tasks", threadId: detail.task.threadId });
    } catch (error) {
      this.loading = false;
      this.error = error;
      this.render();
    }
  }

  async sendFollowUpFromForm(form) {
    this.captureDraft(form);
    const formData = new FormData(form);
    const prompt = `${formData.get("prompt") ?? ""}`.trim();
    if (!prompt || !this.selectedThreadId) {
      return;
    }

    form.prompt.value = "";
    try {
      const detail = await sendTaskPrompt(this.selectedThreadId, prompt);
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.followUpDraft = "";
      this.render();
    } catch (error) {
      this.error = error;
      this.render();
    }
  }

  async interruptSelectedTask() {
    if (!this.selectedThreadId) {
      return;
    }

    try {
      const detail = await interruptTask(this.selectedThreadId);
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.render();
    } catch (error) {
      this.error = error;
      this.render();
    }
  }

  async resolveApproval(approvalId, decision) {
    if (!this.selectedThreadId || !approvalId || !decision) {
      return;
    }

    try {
      const detail = await resolveTaskApproval(this.selectedThreadId, approvalId, decision);
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.render();
    } catch (error) {
      this.error = error;
      this.render();
    }
  }

  requestRoute(route) {
    if (!this.projectId) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: {
            projectId: this.projectId,
            ...route,
          },
        },
      }),
    );
  }

  captureDraft(form) {
    const formData = new FormData(form);
    if (form.dataset.taskForm === "create") {
      this.newTaskDraft = {
        prompt: `${formData.get("prompt") ?? ""}`,
      };
      return;
    }
    if (form.dataset.taskForm === "follow-up") {
      this.followUpDraft = `${formData.get("prompt") ?? ""}`;
    }
  }

  render() {
    this.setAttribute("data-tasks-view", this.view ?? "list");
    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        ${this.renderHeader()}
        ${this.renderBody()}
      </section>
    `;
  }

  renderHeader() {
    const title =
      this.view === "new"
        ? "New Task"
        : this.view === "detail"
          ? "Task"
          : "Tasks";
    const subtitle = this.project?.name ?? "Project";

    return `
      <header class="tasks-header">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <div class="tasks-header-actions">
          ${
            this.view !== "list"
              ? `<button type="button" class="task-icon-button" data-task-action="open-list" title="Open tasks">
                  ${renderInlineIcon("ListTodo", "Open tasks", "task-action-icon")}
                </button>`
              : ""
          }
          <button type="button" class="task-primary-button" data-task-action="open-new">
            ${renderInlineIcon("Plus", "New task", "task-action-icon")}
            <span>New Task</span>
          </button>
        </div>
      </header>
    `;
  }

  renderBody() {
    if (this.loading && !this.taskDetail && this.view === "detail") {
      return `<p class="surface-message">Loading task...</p>`;
    }
    if (this.error) {
      return `<p class="surface-message">${escapeHtml(this.error.message)}</p>`;
    }
    if (this.view === "new") {
      return this.renderNewTask();
    }
    if (this.view === "detail") {
      return this.renderTaskDetail();
    }
    return this.renderTaskList();
  }

  renderTaskList() {
    if (this.loading) {
      return `<p class="surface-message">Loading tasks...</p>`;
    }
    if (!this.tasks.length) {
      return `
        <div class="tasks-empty">
          <p>No tasks yet.</p>
          <button type="button" class="task-primary-button" data-task-action="open-new">New Task</button>
        </div>
      `;
    }

    return `
      <ol class="task-list">
        ${this.tasks.map((task) => this.renderTaskRow(task)).join("")}
      </ol>
    `;
  }

  renderTaskRow(task) {
    const threadId = task.threadId ?? task.id;
    const selected = threadId === this.selectedThreadId ? ` aria-current="true"` : "";
    const summary = task.lastEventSummary || task.preview || task.relativeCwd || task.cwd;
    return `
      <li>
        <button type="button" class="task-row" data-task-action="open-task" data-thread-id="${escapeHtml(threadId)}"${selected}>
          <span class="task-row-title">${escapeHtml(task.title)}</span>
          <span class="task-row-status" data-status="${escapeHtml(task.status)}">${escapeHtml(formatStatus(task.status))}</span>
          <span class="task-row-summary">${escapeHtml(summary || "No preview")}</span>
          <time>${escapeHtml(formatDate(task.recencyMs ?? task.updatedMs))}</time>
        </button>
      </li>
    `;
  }

  renderNewTask() {
    return `
      <form class="task-composer task-new-form" data-task-form="create">
        <label>
          <span>Prompt</span>
          <textarea name="prompt" rows="9" required placeholder="Tell Codex what to do in this project">${escapeHtml(this.newTaskDraft.prompt)}</textarea>
        </label>
        <div class="task-form-actions">
          <button type="button" class="task-secondary-button" data-task-action="open-list">Cancel</button>
          <button type="submit" class="task-primary-button">Start Task</button>
        </div>
      </form>
    `;
  }

  renderTaskDetail() {
    const task = this.taskDetail?.task;
    if (!task) {
      return `<p class="surface-message">${this.loading ? "Loading task..." : "Select a task."}</p>`;
    }
    const approvals = pendingApprovals(this.events);

    return `
      <div class="task-detail">
        <section class="task-detail-summary">
          <div>
            <h2>${escapeHtml(task.title)}</h2>
            <p>
              <span data-status="${escapeHtml(task.status)}">${escapeHtml(formatStatus(task.status))}</span>
              <span>Thread ${escapeHtml(shortId(task.threadId ?? task.id))}</span>
              ${task.relativeCwd ? `<span>${escapeHtml(task.relativeCwd)}</span>` : ""}
            </p>
          </div>
          <div class="task-detail-actions">
            <button type="button" class="task-secondary-button" data-task-action="open-diff">
              ${renderInlineIcon("FileDiff", "Open diff", "task-action-icon")}
              <span>Open Diff</span>
            </button>
            ${
              task.activeTurnId
                ? `<button type="button" class="task-secondary-button" data-task-action="interrupt">Interrupt</button>`
                : ""
            }
          </div>
        </section>
        ${approvals.length ? `<section class="task-approvals">${approvals.map(renderApprovalCard).join("")}</section>` : ""}
        <section class="task-timeline" aria-label="Task timeline">
          <h3>Timeline</h3>
          <ol>
            ${this.events.map(renderTimelineEvent).join("")}
          </ol>
        </section>
        <form class="task-composer task-follow-up-form" data-task-form="follow-up">
          <label>
            <span>Follow-up</span>
            <textarea name="prompt" rows="4" required placeholder="Send another prompt to this task">${escapeHtml(this.followUpDraft)}</textarea>
          </label>
          <div class="task-form-actions">
            <button type="submit" class="task-primary-button">Send Prompt</button>
          </div>
        </form>
      </div>
    `;
  }
}

customElements.define("caffold-tasks-page", CaffoldTasksPage);

function renderTimelineEvent(event) {
  const body = renderEventBody(event);
  return `
    <li class="task-event" data-event-type="${escapeHtml(event.type)}">
      <time>${escapeHtml(formatDate(event.createdMs))}</time>
      <strong>${escapeHtml(event.summary)}</strong>
      <span>${escapeHtml(formatEventType(event.type))}</span>
      ${body}
    </li>
  `;
}

function renderEventBody(event) {
  const payload = event.payload ?? {};
  if (event.type === "prompt_sent" || event.type === "user_message") {
    return renderTextBody("Prompt", payload.prompt ?? payload.text);
  }
  if (event.type === "assistant_message") {
    return renderTextBody("Assistant", payload.text);
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderTextBody("Reasoning", [summary, content].filter(Boolean).join("\n\n"));
  }
  if (event.type === "plan") {
    return renderTextBody("Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return renderCommandBody(payload);
  }
  if (event.type === "file_change") {
    const status = payload.status ? `Status: ${payload.status}` : "";
    const count =
      typeof payload.changeCount === "number"
        ? `Changed files: ${payload.changeCount}`
        : "";
    return renderTextBody("Files", [status, count].filter(Boolean).join("\n"));
  }
  if (event.type === "task_failed") {
    return renderTextBody("Error", event.summary);
  }
  return "";
}

function renderTextBody(label, text) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return "";
  }

  return `
    <div class="task-event-body">
      <span>${escapeHtml(label)}</span>
      <pre>${escapeHtml(value)}</pre>
    </div>
  `;
}

function renderCommandBody(payload) {
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const status = `${payload.status ?? ""}`.trim();
  const output = `${payload.aggregatedOutput ?? ""}`.trim();
  const details = [
    command ? `$ ${command}` : "",
    cwd ? `cwd: ${cwd}` : "",
    status ? `status: ${status}` : "",
    output,
  ]
    .filter(Boolean)
    .join("\n");
  return renderTextBody("Command", details);
}

function renderApprovalCard(event) {
  const payload = event.payload ?? {};
  const params = payload.params ?? {};
  const approvalId = payload.approvalId ?? "";
  const isCommand = payload.kind === "command";
  const decisions = params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];

  return `
    <article class="task-approval-card">
      <header>
        <h3>${isCommand ? "Command Approval" : "File Change Approval"}</h3>
        <span>${escapeHtml(params.reason ?? "Approval requested")}</span>
      </header>
      ${
        isCommand
          ? `<pre>${escapeHtml(formatCommand(params.command))}</pre>
             <p>${escapeHtml(params.cwd ?? "")}</p>`
          : `<p>${escapeHtml(params.grantRoot ? `Grant root: ${params.grantRoot}` : "File change permission requested")}</p>`
      }
      <div class="task-approval-actions">
        ${decisions
          .filter((decision) => ["accept", "acceptForSession", "decline", "cancel"].includes(decision))
          .map(
            (decision) =>
              `<button type="button" class="task-secondary-button" data-task-action="approval" data-approval-id="${escapeHtml(approvalId)}" data-decision="${escapeHtml(decision)}">${escapeHtml(formatDecision(decision))}</button>`,
          )
          .join("")}
      </div>
    </article>
  `;
}

function pendingApprovals(events) {
  const pending = new Map();
  for (const event of events) {
    const approvalId = event.payload?.approvalId;
    if (!approvalId) {
      continue;
    }
    if (event.type === "approval_requested") {
      pending.set(approvalId, event);
    } else if (event.type === "approval_resolved") {
      pending.delete(approvalId);
    }
  }
  return [...pending.values()];
}

function upsertEvent(events, event) {
  const existing = events.filter((entry) => entry.id !== event.id);
  existing.push(event);
  existing.sort((left, right) => (left.createdMs ?? 0) - (right.createdMs ?? 0));
  return existing;
}

function upsertTask(tasks, task) {
  const threadId = task.threadId ?? task.id;
  const existing = tasks.filter((entry) => (entry.threadId ?? entry.id) !== threadId);
  existing.unshift(task);
  return existing;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatStatus(status) {
  return `${status ?? "unknown"}`.replaceAll("_", " ");
}

function formatEventType(type) {
  return `${type ?? ""}`.replaceAll("_", " ");
}

function formatDecision(decision) {
  return {
    accept: "Accept",
    acceptForSession: "Accept for Session",
    decline: "Decline",
    cancel: "Cancel",
  }[decision] ?? decision;
}

function formatCommand(command) {
  if (Array.isArray(command)) {
    return command.join(" ");
  }
  if (typeof command === "string" && command.trim()) {
    return command;
  }
  if (command && typeof command === "object") {
    return JSON.stringify(command);
  }
  return "(command unavailable)";
}

function shortId(id) {
  return `${id ?? ""}`.slice(0, 8);
}

function formatDate(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
