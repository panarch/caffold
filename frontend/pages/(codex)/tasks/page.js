import {
  createTask,
  getCodexModels,
  getTask,
  getTasks,
  interruptTask,
  resolveTaskApproval,
  sendTaskPrompt,
  taskStreamUrl,
} from "../../../api.js";
import { escapeHtml } from "../../../components/dom.js";
import "../../../components/file-browser.js";
import { renderInlineIcon, warmIcons } from "../../../components/icons.js";

const FALLBACK_REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "ultra", label: "Very high" },
];
const FALLBACK_EFFORT = "ultra";

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
    this.eventsPage = { nextCursor: null };
    this.error = null;
    this.loading = false;
    this.loadingOlderEvents = false;
    this.project = null;
    this.projectId = "";
    this.selectedThreadId = "";
    this.stream = null;
    this.requestId = 0;
    this.conversationScrollMode = null;
    this.newTaskDraft = { prompt: "" };
    this.followUpDraft = "";
    this.modelOptions = [];
    this.modelOptionsLoaded = false;
    this.modelOptionsLoading = false;
    this.modelOptionsError = null;
    this.composerSettings = {
      model: "",
      effort: "",
    };
    this.taskDetailView = "conversation";
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    this.addEventListener(
      "click",
      (event) => {
        const action = closestElement(event.target, "[data-task-action]");
        if (!action) {
          return;
        }

        this.handleAction(action.dataset.taskAction, action);
      },
      true,
    );
    this.addEventListener("input", (event) => {
      const textarea = closestElement(event.target, "textarea[name='prompt']");
      if (textarea) {
        syncComposerTextarea(textarea);
      }

      const form = closestElement(event.target, "form[data-task-form]");
      if (!form) {
        return;
      }

      this.captureDraft(form);
    });
    this.addEventListener("keydown", (event) => this.handlePromptKeydown(event));
    this.addEventListener(
      "submit",
      (event) => {
        const form = closestElement(event.target, "form[data-task-form]");
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
    const nextProjectId = project?.id ?? "";
    if (nextProjectId !== this.projectId) {
      this.taskDetailView = "conversation";
    }
    this.project = project ?? null;
    this.projectId = nextProjectId;
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
      this.taskDetailView = "conversation";
      this.selectedThreadId = "";
      this.closeStream();
    } else if (route?.threadId) {
      if (this.selectedThreadId !== route.threadId) {
        this.taskDetailView = "conversation";
      }
      this.view = "detail";
      this.selectedThreadId = route.threadId;
      this.taskDetail =
        this.taskDetail?.task?.threadId === route.threadId ? this.taskDetail : null;
      this.eventsPage =
        this.taskDetail?.task?.threadId === route.threadId
          ? this.eventsPage
          : { nextCursor: null };
    } else {
      this.view = "list";
      this.taskDetailView = "conversation";
      this.selectedThreadId = "";
      this.eventsPage = { nextCursor: null };
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
    this.loadModelOptions();
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
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.loading = false;
      this.connectStream(threadId);
      this.conversationScrollMode = "bottom";
      this.render();
      this.loadModelOptions();
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

    const requestId = this.requestId;
    try {
      const detail = await getTask(this.selectedThreadId, this.projectId);
      if (requestId !== this.requestId) {
        return;
      }
      if (detail?.task?.threadId !== this.selectedThreadId) {
        return;
      }
      this.taskDetail = detail;
      this.events = mergeEvents(this.events, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.conversationScrollMode = "bottom-if-needed";
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
    if (action === "toggle-files") {
      this.setTaskDetailView(this.taskDetailView === "files" ? "conversation" : "files");
      return;
    }
    if (action === "interrupt") {
      this.interruptSelectedTask();
      return;
    }
    if (action === "approval") {
      this.resolveApproval(element.dataset.approvalId, element.dataset.decision);
      return;
    }
    if (action === "select-model") {
      this.selectModel(element.dataset.model);
      closePopoverFor(element);
      return;
    }
    if (action === "select-effort") {
      this.selectEffort(element.dataset.effort);
      closePopoverFor(element);
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

  handlePromptKeydown(event) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    if (event.isComposing) {
      return;
    }

    const textarea = closestElement(event.target, "textarea[name='prompt']");
    const form = closestElement(textarea, "form[data-task-form]");
    if (!textarea || !form || !textarea.value.trim()) {
      return;
    }

    event.preventDefault();
    form.requestSubmit();
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
        ...this.turnOptions(),
      });
      this.taskDetail = detail;
      this.events = detail.events ?? [];
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.tasks = upsertTask(this.tasks, detail.task);
      this.newTaskDraft = { prompt: "" };
      this.conversationScrollMode = "bottom";
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
    const requestId = ++this.requestId;
    const optimisticEvent = optimisticUserMessageEvent(
      this.selectedThreadId,
      prompt,
      requestId,
    );
    this.events = mergeEvents(this.events, [optimisticEvent]);
    this.followUpDraft = "";
    this.conversationScrollMode = "bottom";
    this.render();

    try {
      const detail = await sendTaskPrompt(
        this.selectedThreadId,
        this.projectId,
        prompt,
        this.turnOptions(),
      );
      if (requestId !== this.requestId) {
        return;
      }
      this.taskDetail = detail;
      this.events = mergeEvents(this.events, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.followUpDraft = "";
      this.conversationScrollMode = "bottom";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = error;
      this.render();
    }
  }

  async interruptSelectedTask() {
    if (!this.selectedThreadId) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await interruptTask(this.selectedThreadId, this.projectId);
      if (requestId !== this.requestId) {
        return;
      }
      this.taskDetail = detail;
      this.events = mergeEvents(this.events, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = error;
      this.render();
    }
  }

  async resolveApproval(approvalId, decision) {
    if (!this.selectedThreadId || !approvalId || !decision) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await resolveTaskApproval(
        this.selectedThreadId,
        this.projectId,
        approvalId,
        decision,
      );
      if (requestId !== this.requestId) {
        return;
      }
      this.taskDetail = detail;
      this.events = mergeEvents(this.events, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = error;
      this.render();
    }
  }

  async loadOlderEvents() {
    const cursor = this.eventsPage?.nextCursor;
    if (!this.selectedThreadId || !cursor || this.loadingOlderEvents) {
      return;
    }

    this.loadingOlderEvents = true;
    this.conversationScrollMode = "preserve";
    const requestId = ++this.requestId;
    this.render();
    try {
      const detail = await getTask(this.selectedThreadId, this.projectId, cursor);
      if (requestId !== this.requestId) {
        return;
      }
      if (detail?.task?.threadId !== this.selectedThreadId) {
        this.loadingOlderEvents = false;
        this.conversationScrollMode = "preserve";
        this.render();
        return;
      }
      this.taskDetail = {
        ...detail,
        task: this.taskDetail?.task ?? detail.task,
      };
      this.events = mergeEvents(detail.events ?? [], this.events);
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.loadingOlderEvents = false;
      this.conversationScrollMode = "prepend";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.loadingOlderEvents = false;
      this.error = error;
      this.conversationScrollMode = "preserve";
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

  async loadModelOptions() {
    if (this.modelOptionsLoaded || this.modelOptionsLoading) {
      return;
    }

    this.modelOptionsLoading = true;
    this.modelOptionsError = null;
    this.render();
    try {
      const response = await getCodexModels();
      this.modelOptions = normalizeModelOptions(response);
      this.modelOptionsLoaded = true;
      this.applyDefaultModelSelection();
    } catch (error) {
      this.modelOptionsError = error;
      this.modelOptionsLoaded = true;
    } finally {
      this.modelOptionsLoading = false;
      this.render();
    }
  }

  applyDefaultModelSelection() {
    if (!this.modelOptions.length) {
      return;
    }
    const selected = this.selectedModelOption();
    const model = selected ?? this.modelOptions.find((option) => option.isDefault) ?? this.modelOptions[0];
    if (!this.composerSettings.model) {
      this.composerSettings.model = model.model;
    }
    if (!this.composerSettings.effort) {
      this.composerSettings.effort =
        model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.value || "";
    }
  }

  selectModel(modelValue) {
    this.composerSettings.model = `${modelValue ?? ""}`;
    const model = this.selectedModelOption();
    const supported = this.reasoningOptionsForModel(model).map((option) => option.value);
    if (this.composerSettings.effort && !supported.includes(this.composerSettings.effort)) {
      this.composerSettings.effort =
        model?.defaultReasoningEffort ?? supported[0] ?? FALLBACK_EFFORT;
    }
    this.render();
  }

  selectEffort(effort) {
    this.composerSettings.effort = `${effort ?? ""}`;
    this.render();
  }

  selectedModelOption() {
    return this.modelOptions.find((option) => option.model === this.composerSettings.model) ?? null;
  }

  selectedEffort() {
    return this.composerSettings.effort || this.selectedModelOption()?.defaultReasoningEffort || FALLBACK_EFFORT;
  }

  turnOptions() {
    return {
      model: this.composerSettings.model || undefined,
      effort: this.selectedEffort() || undefined,
    };
  }

  reasoningOptionsForModel(model) {
    return model?.supportedReasoningEfforts?.length
      ? model.supportedReasoningEfforts
      : FALLBACK_REASONING_OPTIONS;
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
    const previousScroll = this.captureConversationScroll();
    const previousTaskFilePath = this.captureTaskFileBrowserPath();
    this.setAttribute("data-tasks-view", this.view ?? "list");
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        ${this.renderHeader()}
        ${this.renderBody()}
      </section>
    `;
    this.syncComposerTextareas();
    this.bindConversationScroll();
    this.restoreConversationScroll(previousScroll);
    this.updateTaskDetailView();
    this.syncTaskFileBrowser(previousTaskFilePath);
  }

  setTaskDetailView(view) {
    const nextView = view === "files" ? "files" : "conversation";
    if (this.taskDetailView === nextView) {
      return;
    }

    this.taskDetailView = nextView;
    this.updateTaskDetailView();
    this.syncTaskFileBrowser();
    this.dispatchTaskDetailViewChange();
  }

  closeActiveSubview() {
    if (this.taskDetailView !== "files") {
      return false;
    }

    this.setTaskDetailView("conversation");
    return true;
  }

  updateTaskDetailView() {
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    const detail = this.querySelector(".task-detail");
    if (!detail) {
      return;
    }

    detail.dataset.taskDetailView = this.taskDetailView;
    const filesButton = detail.querySelector('button[data-task-action="toggle-files"]');
    if (filesButton) {
      filesButton.setAttribute(
        "aria-pressed",
        this.taskDetailView === "files" ? "true" : "false",
      );
    }
  }

  dispatchTaskDetailViewChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-view-change", {
        bubbles: true,
        detail: { view: this.taskDetailView },
      }),
    );
  }

  captureTaskFileBrowserPath() {
    const browser = this.querySelector(".task-files-view caffold-file-browser");
    return browser?.currentPath ?? "";
  }

  syncTaskFileBrowser(previousPath = "") {
    if (this.taskDetailView !== "files") {
      return;
    }

    const browser = this.querySelector(".task-files-view caffold-file-browser");
    const targetPath = previousPath || this.project?.relativePath || "";
    if (!browser) {
      return;
    }

    browser.ensureRendered();
    browser.setStorageKey(null);
    if (!browser.hasLoadedDirectory(targetPath)) {
      browser.loadDirectory(targetPath, { allowFailure: true });
    }
  }

  syncComposerTextareas() {
    this.querySelectorAll("textarea[name='prompt']").forEach((textarea) =>
      syncComposerTextarea(textarea),
    );
  }

  bindConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    scroller?.addEventListener("scroll", () => this.handleConversationScroll());
  }

  captureConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller) {
      return null;
    }
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: isScrolledToBottom(scroller),
    };
  }

  restoreConversationScroll(previousScroll) {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller) {
      this.conversationScrollMode = null;
      return;
    }

    const mode = this.conversationScrollMode;
    this.conversationScrollMode = null;
    const shouldStickToBottom =
      mode === "bottom" ||
      (mode === "bottom-if-needed" && previousScroll?.atBottom) ||
      (!mode && previousScroll?.atBottom);
    if (shouldStickToBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
      return;
    }
    if (mode === "prepend" && previousScroll) {
      scroller.scrollTop = Math.min(
        previousScroll.scrollTop + (scroller.scrollHeight - previousScroll.scrollHeight),
        maxScrollTop(scroller),
      );
      return;
    }
    if (previousScroll) {
      scroller.scrollTop = Math.min(previousScroll.scrollTop, maxScrollTop(scroller));
    }
  }

  handleConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (
      !scroller ||
      this.loadingOlderEvents ||
      !this.eventsPage?.nextCursor ||
      scroller.scrollTop > 32
    ) {
      return;
    }
    this.loadOlderEvents();
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
    return this.renderTaskComposer({
      formName: "create",
      className: "task-new-form",
      prompt: this.newTaskDraft.prompt,
      placeholder: "Ask Codex to work in this project",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: true,
    });
  }

  renderTaskComposer({
    formName,
    className,
    prompt,
    placeholder,
    ariaLabel,
    submitLabel,
    cancel = false,
  }) {
    const model = this.selectedModelOption();
    const effort = this.selectedEffort();
    return `
      <form class="task-composer ${escapeHtml(className)}" data-task-form="${escapeHtml(formName)}">
        <div class="task-composer-panel">
          <textarea
            name="prompt"
            required
            rows="2"
            data-max-rows="10.5"
            aria-label="${escapeHtml(ariaLabel)}"
            placeholder="${escapeHtml(placeholder)}"
          >${escapeHtml(prompt ?? "")}</textarea>
          <input type="hidden" name="model" value="${escapeHtml(model?.model ?? "")}">
          <input type="hidden" name="effort" value="${escapeHtml(effort)}">
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              ${
                cancel
                  ? `<button type="button" class="task-toolbar-button" data-task-action="open-list">Cancel</button>`
                  : ""
              }
              ${this.renderModelPicker(formName)}
            </div>
            <button type="submit" class="task-send-button" aria-label="${escapeHtml(submitLabel)}" title="${escapeHtml(submitLabel)}">
              <span class="task-send-arrow" aria-hidden="true">&uarr;</span>
            </button>
          </div>
        </div>
      </form>
    `;
  }

  renderModelPicker(formName) {
    const popoverId = `task-model-picker-${formName}`;
    const model = this.selectedModelOption();
    const modelLabel = model?.displayName ?? (this.modelOptionsLoading ? "Loading model" : "Model");
    const effort = this.selectedEffort();
    const effortLabel = reasoningLabel(effort);
    const modelRows = this.modelOptions.length
      ? this.modelOptions.map((option) => renderModelOption(option, this.composerSettings.model)).join("")
      : renderModelFallback(this.modelOptionsLoading, this.modelOptionsError);
    const reasoningRows = this.reasoningOptionsForModel(model)
      .map((option) => renderReasoningOption(option, effort))
      .join("");

    return `
      <div class="task-model-picker">
        <button
          type="button"
          class="task-model-button"
          popovertarget="${escapeHtml(popoverId)}"
          aria-label="Choose model and reasoning"
        >
          ${renderInlineIcon("Circle", "Model", "task-model-icon")}
          <span>${escapeHtml(modelLabel)}</span>
          <span>${escapeHtml(effortLabel)}</span>
          <span class="task-model-caret" aria-hidden="true">&#8964;</span>
        </button>
        <div id="${escapeHtml(popoverId)}" class="task-model-popover" popover>
          <section>
            <p>Reasoning level</p>
            ${reasoningRows}
          </section>
          <hr>
          <section>
            <p>Model</p>
            ${modelRows}
          </section>
        </div>
      </div>
    `;
  }

  renderTaskDetail() {
    const task = this.taskDetail?.task;
    if (!task) {
      return `<p class="surface-message">${this.loading ? "Loading task..." : "Select a task."}</p>`;
    }
    const approvals = pendingApprovals(this.events);

    return `
      <div class="task-detail" data-task-detail-view="${escapeHtml(this.taskDetailView)}">
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
            <button
              type="button"
              class="task-secondary-button"
              data-task-action="toggle-files"
              aria-pressed="${this.taskDetailView === "files" ? "true" : "false"}"
            >
              ${renderInlineIcon("Folder", "Files", "task-action-icon")}
              <span>Files</span>
            </button>
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
        <section class="task-conversation-pane" aria-label="Task conversation">
          <div class="task-conversation-scroll">
            <div class="task-conversation-column">
              ${approvals.length ? `<section class="task-approvals">${approvals.map(renderApprovalCard).join("")}</section>` : ""}
              ${this.eventsPage?.nextCursor || this.loadingOlderEvents ? `<div class="task-load-older">${this.loadingOlderEvents ? "Loading older..." : ""}</div>` : ""}
              <ol class="task-conversation" aria-label="Task conversation">
                ${renderConversation(this.events, task)}
              </ol>
            </div>
          </div>
          ${this.renderTaskComposer({
            formName: "follow-up",
            className: "task-follow-up-form",
            prompt: this.followUpDraft,
            placeholder: "Send another prompt to this task",
            ariaLabel: "Follow-up prompt",
            submitLabel: "Send prompt",
          })}
        </section>
        ${this.renderTaskFilesView()}
      </div>
    `;
  }

  renderTaskFilesView() {
    return `
      <section class="task-files-view" aria-label="Task files">
        <header class="task-files-header">
          <div>
            <h3>Files</h3>
            <p>${escapeHtml(this.project?.name ?? "Project")}</p>
          </div>
        </header>
        <caffold-file-browser></caffold-file-browser>
      </section>
    `;
  }
}

customElements.define("caffold-tasks-page", CaffoldTasksPage);

function normalizeModelOptions(response) {
  const models = Array.isArray(response?.data) ? response.data : [];
  return models
    .map((model) => {
      const modelValue = `${model?.model ?? model?.id ?? ""}`.trim();
      if (!modelValue) {
        return null;
      }
      return {
        model: modelValue,
        displayName: `${model?.displayName ?? modelValue}`.trim(),
        description: `${model?.description ?? ""}`.trim(),
        isDefault: Boolean(model?.isDefault),
        defaultReasoningEffort: `${model?.defaultReasoningEffort ?? ""}`.trim(),
        supportedReasoningEfforts: normalizeReasoningOptions(
          model?.supportedReasoningEfforts,
        ),
      };
    })
    .filter(Boolean);
}

function normalizeReasoningOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    return [];
  }
  return options
    .map((option) => {
      const value = `${option?.reasoningEffort ?? option ?? ""}`.trim();
      if (!value) {
        return null;
      }
      return {
        value,
        label: reasoningLabel(value),
        description: `${option?.description ?? ""}`.trim(),
      };
    })
    .filter(Boolean);
}

function reasoningLabel(value) {
  switch (value) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "ultra":
      return "Very high";
    default:
      return value ? titleCase(value) : "Reasoning";
  }
}

function titleCase(value) {
  return `${value}`
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderReasoningOption(option, selectedEffort) {
  const selected = option.value === selectedEffort;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-effort"
      data-effort="${escapeHtml(option.value)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.label)}</strong>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderModelOption(option, selectedModel) {
  const selected = option.model === selectedModel;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-model"
      data-model="${escapeHtml(option.model)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.displayName)}</strong>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderModelFallback(loading, error) {
  if (loading) {
    return `<p class="task-model-note">Loading models...</p>`;
  }
  if (error) {
    return `<p class="task-model-note">Model list unavailable. The default Codex model will be used.</p>`;
  }
  return `<p class="task-model-note">Open this menu after Codex is connected.</p>`;
}

function closePopoverFor(element) {
  const popover = closestElement(element, "[popover]");
  if (popover && "hidePopover" in popover) {
    popover.hidePopover();
  }
}

function renderConversation(events, task) {
  const conversationEvents = dedupeCanonicalEvents(events);
  const userPrompts = new Set(
    conversationEvents
      .filter((event) => event.type === "user_message")
      .map((event) => `${event.payload?.text ?? event.payload?.prompt ?? ""}`.trim())
      .filter(Boolean),
  );
  return conversationGroups(conversationEvents)
    .map((group) => {
      if (group.kind === "turn") {
        return renderTurnGroup(group, task);
      }
      if (!shouldRenderStandaloneEvent(group.event, userPrompts)) {
        return "";
      }
      return renderConversationEvent(group.event, task, { active: false });
    })
    .join("");
}

function conversationGroups(events) {
  const groups = [];
  const turns = new Map();
  let activeGroup = null;

  const createImplicitTurnGroup = () => {
    const group = { kind: "turn", turnId: `implicit-${groups.length}`, events: [] };
    groups.push(group);
    activeGroup = group;
    return group;
  };

  for (const event of events) {
    const turnId = eventTurnId(event);
    if (!turnId) {
      if (event.type === "user_message") {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      if (isImplicitTurnEvent(event) && canAcceptTurnContinuation(activeGroup)) {
        activeGroup.events.push(event);
        continue;
      }
      if (isImplicitTurnEvent(event)) {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      groups.push({ kind: "event", event });
      continue;
    }

    let group = turns.get(turnId);
    if (!group) {
      group = { kind: "turn", turnId, events: [] };
      turns.set(turnId, group);
      groups.push(group);
    }
    group.events.push(event);
    activeGroup = isTerminalTurnEvent(event) ? null : group;
  }
  return groups;
}

function eventTurnId(event) {
  const payload = event?.payload ?? {};
  return payload.turnId ?? payload.turn?.id ?? null;
}

function renderTurnGroup(group, task) {
  const userEvents = group.events.filter((event) => event.type === "user_message");
  const assistantEvents = group.events.filter((event) => event.type === "assistant_message");
  const workEvents = group.events.filter(isWorkEvent);
  const statusEvents = group.events.filter(isTurnStatusEvent);
  const terminalEvent = statusEvents.find(isTerminalTurnEvent);
  const isCurrentTurn = task?.activeTurnId === group.turnId;
  const isActive =
    ["running", "waiting_for_approval"].includes(task?.status) &&
    (isCurrentTurn || (!terminalEvent && assistantEvents.length === 0));
  const isComplete = Boolean(terminalEvent) || (assistantEvents.length > 0 && !isActive);

  const output = [];
  output.push(
    ...userEvents.map((event) =>
      renderConversationEvent(event, task, { active: false }),
    ),
  );

  if (isComplete && assistantEvents.length > 0) {
    const finalAssistantEvent = assistantEvents.at(-1);
    const progressAssistantEvents = assistantEvents.slice(0, -1);
    const hiddenWorkEvents = [...progressAssistantEvents, ...workEvents];
    if (hiddenWorkEvents.length > 0) {
      output.push(renderTurnWorkSummary(group, hiddenWorkEvents, terminalEvent));
    }
    output.push(renderConversationEvent(finalAssistantEvent, task, { active: false }));
    return output.join("");
  }

  output.push(
    ...workEvents.map((event) =>
      renderConversationEvent(event, task, { active: isActive }),
    ),
  );
  output.push(
    ...assistantEvents.map((event) =>
      renderConversationEvent(event, task, { active: false }),
    ),
  );
  return output.join("");
}

function shouldRenderStandaloneEvent(event, userPrompts) {
  if (event.type === "prompt_sent") {
    const prompt = `${event.payload?.prompt ?? event.payload?.text ?? ""}`.trim();
    return Boolean(prompt && !userPrompts.has(prompt));
  }
  return ![
    "thread_started",
    "turn_started",
    "turn_completed",
    "approval_requested",
    "approval_resolved",
    "diff_updated",
  ].includes(event.type);
}

function renderConversationEvent(event, task, eventState) {
  const payload = event.payload ?? {};
  if (event.type === "prompt_sent" || event.type === "user_message") {
    if (event.type === "prompt_sent") {
      return renderStatusEvent(event);
    }
    return renderMessageEvent(event, "user", payload.prompt ?? payload.text);
  }
  if (event.type === "assistant_message") {
    return renderMessageEvent(event, "assistant", payload.text);
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderThinkingEvent(
      event,
      [summary, content].filter(Boolean).join("\n\n"),
      task,
      eventState,
    );
  }
  if (event.type === "plan") {
    return renderToolEvent(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return renderCommandEvent(event);
  }
  if (event.type === "file_change") {
    return renderFileChangeEvent(event);
  }
  if (event.type === "task_failed") {
    return renderToolEvent(event, "Error", event.summary, "danger");
  }
  return renderStatusEvent(event);
}

function isWorkEvent(event) {
  return ["reasoning", "plan", "command_execution", "file_change", "task_failed"].includes(
    event.type,
  );
}

function isTurnContinuationEvent(event) {
  return isWorkEvent(event) || isTurnStatusEvent(event);
}

function isImplicitTurnEvent(event) {
  return event.type === "assistant_message" || isTurnContinuationEvent(event);
}

function canAcceptTurnContinuation(group) {
  if (!group || group.kind !== "turn") {
    return false;
  }
  const events = group.events ?? [];
  return !events.some((event) => isTerminalTurnEvent(event));
}

function isTurnStatusEvent(event) {
  return [
    "turn_started",
    "turn_completed",
    "turn_interrupted",
    "approval_resolved",
    "diff_updated",
  ].includes(event.type);
}

function isTerminalTurnEvent(event) {
  if (!isTurnStatusEvent(event)) {
    return false;
  }
  const status = event.payload?.status ?? event.type;
  return (
    event.type === "turn_completed" ||
    event.type === "turn_interrupted" ||
    ["completed", "failed", "interrupted"].includes(status)
  );
}

function renderStatusEvent(event) {
  const status = statusTone(event.type);
  return `
    <li class="task-event task-event-status" data-event-type="${escapeHtml(event.type)}" data-event-status="${escapeHtml(status)}">
      <span class="task-status-chip">${escapeHtml(event.summary)}</span>
      <time>${escapeHtml(formatDate(event.createdMs))}</time>
    </li>
  `;
}

function renderMessageEvent(event, role, text) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }

  return `
    <li class="task-event task-message" data-event-type="${escapeHtml(event.type)}" data-message-role="${escapeHtml(role)}">
      <div class="task-message-header">
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </div>
      <pre class="task-message-content">${escapeHtml(value)}</pre>
    </li>
  `;
}

function renderThinkingEvent(event, text, task, eventState) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }
  const isActive =
    eventState?.active ??
    ["running", "waiting_for_approval"].includes(task?.status);
  const open = isActive ? " open" : "";
  const state = isActive ? "active" : "complete";

  return `
    <li class="task-event task-thinking" data-event-type="${escapeHtml(event.type)}" data-thinking-state="${escapeHtml(state)}">
      <details${open}>
        <summary>
          <span>Thinking</span>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <pre>${escapeHtml(value)}</pre>
      </details>
    </li>
  `;
}

function renderTurnWorkSummary(group, workEvents, terminalEvent) {
  const duration = turnDurationLabel(group.events, terminalEvent);
  const count = workEvents.length;
  const updateText = count === 1 ? "1 update" : `${count} updates`;
  const label = duration ? `Worked for ${duration}` : "Work details";
  return `
    <li class="task-event task-turn-work" data-turn-id="${escapeHtml(group.turnId)}">
      <details>
        <summary>
          <span>${escapeHtml(label)}</span>
          <span>${escapeHtml(updateText)}</span>
        </summary>
        <div class="task-turn-work-body">
          ${renderTurnWorkItems(workEvents)}
        </div>
      </details>
    </li>
  `;
}

function turnDurationLabel(events, terminalEvent) {
  const started = events.find((event) => event.type === "turn_started");
  const startMs = started?.createdMs ?? events[0]?.createdMs;
  const endMs = terminalEvent?.createdMs ?? events.at(-1)?.createdMs;
  if (typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) {
    return "";
  }
  return formatDuration(endMs - startMs);
}

function renderTurnWorkItems(events) {
  const assistantEvents = events.filter((event) => event.type === "assistant_message");
  const reasoningEvents = events.filter((event) => event.type === "reasoning");
  const planEvents = events.filter((event) => event.type === "plan");
  const commandEvents = events.filter((event) => event.type === "command_execution");
  const fileChangeEvents = events.filter((event) => event.type === "file_change");
  const failureEvents = events.filter((event) => event.type === "task_failed");
  const knownEvents = new Set([
    ...assistantEvents,
    ...reasoningEvents,
    ...planEvents,
    ...commandEvents,
    ...fileChangeEvents,
    ...failureEvents,
  ]);
  const unknownEvents = events.filter((event) => !knownEvents.has(event));

  return [
    ...assistantEvents.map(renderTurnWorkItem),
    renderCombinedReasoningWorkItem(reasoningEvents),
    ...planEvents.map(renderTurnWorkItem),
    ...commandEvents.map(renderTurnWorkItem),
    renderCombinedFileChangeWorkItem(fileChangeEvents),
    ...failureEvents.map(renderTurnWorkItem),
    ...unknownEvents.map(renderTurnWorkItem),
  ]
    .filter(Boolean)
    .join("");
}

function renderCombinedReasoningWorkItem(events) {
  if (!events.length) {
    return "";
  }
  const text = events
    .map((event) => {
      const payload = event.payload ?? {};
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter(Boolean).join("\n\n")
        : "";
      const content = Array.isArray(payload.content)
        ? payload.content.filter(Boolean).join("\n\n")
        : "";
      return [summary, content].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return renderTurnWorkItemShell(latestEvent(events), "Thinking", text);
}

function renderCombinedFileChangeWorkItem(events) {
  if (!events.length) {
    return "";
  }
  if (events.length === 1) {
    return renderTurnWorkItem(events[0]);
  }

  const latest = latestEvent(events);
  const payload = latest.payload ?? {};
  const latestCount =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : null;
  const latestSummary =
    typeof latestCount === "number"
      ? latestCount === 1
        ? "Latest: 1 changed file"
        : `Latest: ${latestCount} changed files`
      : "";
  const status = payload.status ? `Latest status: ${formatStatus(payload.status)}` : "";
  const updateText =
    events.length === 1
      ? "1 file change update"
      : `${events.length} file change updates`;

  return renderTurnWorkItemShell(
    latest,
    "Files changed",
    [updateText, latestSummary, status].filter(Boolean).join("\n"),
  );
}

function latestEvent(events) {
  return events.reduce((latest, event) =>
    (event.createdMs ?? 0) >= (latest.createdMs ?? 0) ? event : latest,
  );
}

function renderTurnWorkItem(event) {
  const payload = event.payload ?? {};
  const dataType = escapeHtml(event.type);
  if (event.type === "assistant_message") {
    return renderTurnWorkItemShell(event, "Update", payload.text);
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderTurnWorkItemShell(event, "Thinking", [summary, content].filter(Boolean).join("\n\n"));
  }
  if (event.type === "plan") {
    return renderTurnWorkItemShell(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    const command = `${payload.command ?? ""}`.trim();
    const cwd = `${payload.cwd ?? ""}`.trim();
    const status = `${payload.status ?? ""}`.trim();
    const output = `${payload.aggregatedOutput ?? ""}`.trim();
    return renderTurnWorkItemShell(
      event,
      "Command",
      [
        command ? `$ ${command}` : "",
        cwd ? `cwd: ${cwd}` : "",
        status ? `status: ${status}` : "",
        output,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (event.type === "file_change") {
    const count =
      typeof payload.changeCount === "number"
        ? payload.changeCount
        : Array.isArray(payload.changes)
          ? payload.changes.length
          : 0;
    const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
    const summary = count === 1 ? "1 changed file" : `${count} changed files`;
    return renderTurnWorkItemShell(event, "Files changed", [summary, status].filter(Boolean).join("\n"));
  }
  if (event.type === "task_failed") {
    return renderTurnWorkItemShell(event, "Error", event.summary, "danger");
  }
  return `
    <article class="task-work-item" data-event-type="${dataType}">
      <header>
        <strong>${escapeHtml(event.summary)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
    </article>
  `;
}

function renderTurnWorkItemShell(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-item" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
    </article>
  `;
}

function renderToolEvent(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }

  return `
    <li class="task-event task-tool-card" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      <pre>${escapeHtml(value)}</pre>
    </li>
  `;
}

function renderCommandEvent(event) {
  const payload = event.payload ?? {};
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
  const open = status && status !== "completed" ? " open" : "";
  return `
    <li class="task-event task-command" data-event-type="${escapeHtml(event.type)}" data-command-status="${escapeHtml(status || "unknown")}">
      <details${open}>
        <summary>
          <span>Command</span>
          ${status ? `<span>${escapeHtml(formatStatus(status))}</span>` : ""}
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <pre>${escapeHtml(details || "(command unavailable)")}</pre>
      </details>
    </li>
  `;
}

function renderFileChangeEvent(event) {
  const payload = event.payload ?? {};
  const count =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : 0;
  const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
  const summary = count === 1 ? "1 changed file" : `${count} changed files`;
  return `
    <li class="task-event task-file-change" data-event-type="${escapeHtml(event.type)}">
      <article>
        <header>
          <strong>Files changed</strong>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </header>
        <p>${escapeHtml(summary)}${status ? ` · ${status}` : ""}</p>
      </article>
    </li>
  `;
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
  return mergeEvents(events, [event]);
}

function mergeEvents(leftEvents, rightEvents) {
  const byId = new Map();
  for (const event of [...leftEvents, ...rightEvents]) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, event);
    }
  }
  return dedupeCanonicalEvents([...byId.values()]).sort(
    (left, right) =>
      (left.createdMs ?? 0) - (right.createdMs ?? 0) ||
      `${left.id ?? ""}`.localeCompare(`${right.id ?? ""}`),
  );
}

function optimisticUserMessageEvent(threadId, prompt, requestId) {
  const createdMs = Date.now();
  return {
    id: `local:user:${threadId}:${requestId}:${createdMs}`,
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      text: prompt,
      optimistic: true,
    },
    createdMs,
  };
}

function eventIdentityKey(event) {
  if (!event) {
    return "";
  }

  const payload = event.payload ?? {};
  const threadId = event.threadId ?? payload.threadId ?? "";
  const itemId = payload.itemId ?? payload.item?.id ?? "";
  if (itemId) {
    return ["item", threadId, itemId].join(":");
  }

  const approvalId = payload.approvalId ?? "";
  if (approvalId) {
    return ["approval", threadId, approvalId, event.type].join(":");
  }

  const turnId = eventTurnId(event);
  if (turnId && isTurnStatusEvent(event)) {
    return ["turn", threadId, turnId, event.type, payload.status ?? ""].join(":");
  }

  if (turnId && ["user_message", "assistant_message"].includes(event.type)) {
    const text = `${payload.prompt ?? payload.text ?? ""}`.trim();
    if (text) {
      return ["message", threadId, turnId, event.type, text].join(":");
    }
  }

  return event.id ?? "";
}

function dedupeCanonicalEvents(events) {
  const byKey = new Map();
  for (const event of removeSupersededOptimisticEvents(events)) {
    const key = canonicalEventKey(event) || eventIdentityKey(event);
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    byKey.set(key, preferStructuredEvent(existing, event));
  }
  return [...byKey.values()];
}

function removeSupersededOptimisticEvents(events) {
  const confirmedUserMessages = new Set();
  for (const event of events) {
    if (event?.type !== "user_message" || event.payload?.optimistic) {
      continue;
    }
    const text = `${event.payload?.prompt ?? event.payload?.text ?? ""}`.trim();
    if (text) {
      confirmedUserMessages.add([event.threadId ?? "", text].join(":"));
    }
  }

  return events.filter((event) => {
    if (event?.type !== "user_message" || !event.payload?.optimistic) {
      return true;
    }
    const text = `${event.payload?.prompt ?? event.payload?.text ?? ""}`.trim();
    return !confirmedUserMessages.has([event.threadId ?? "", text].join(":"));
  });
}

function canonicalEventKey(event) {
  if (!event || !["user_message", "assistant_message"].includes(event.type)) {
    return "";
  }

  if (event.payload?.optimistic) {
    return event.id ?? "";
  }

  const payload = event.payload ?? {};
  const text = `${payload.prompt ?? payload.text ?? ""}`.trim();
  if (!text) {
    return "";
  }

  const threadId = event.threadId ?? payload.threadId ?? "";
  const turnId = eventTurnId(event);
  if (turnId) {
    return ["message", threadId, turnId, event.type, text].join(":");
  }

  const createdMs = typeof event.createdMs === "number" ? event.createdMs : 0;
  const createdBucket = createdMs ? Math.floor(createdMs / 5000) : "";
  return ["message", threadId, event.type, text, createdBucket].join(":");
}

function preferStructuredEvent(existing, next) {
  if (!existing) {
    return next;
  }
  return eventStructureScore(next) >= eventStructureScore(existing) ? next : existing;
}

function eventStructureScore(event) {
  const payload = event?.payload ?? {};
  return [
    payload.itemId,
    payload.item?.id,
    payload.turnId,
    payload.threadId,
  ].filter(Boolean).length;
}

function isScrolledToBottom(element) {
  return maxScrollTop(element) - element.scrollTop <= 8;
}

function maxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

function syncComposerTextarea(textarea) {
  const styles = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
  const padding =
    (Number.parseFloat(styles.paddingTop) || 0) +
    (Number.parseFloat(styles.paddingBottom) || 0);
  const maxRows = Number.parseFloat(textarea.dataset.maxRows ?? "10.5") || 10.5;
  const maxHeight = lineHeight * maxRows + padding;

  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
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

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(seconds)) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function statusTone(type) {
  if (type === "task_failed" || type === "turn_interrupted") {
    return "danger";
  }
  if (type === "approval_requested") {
    return "warning";
  }
  return "muted";
}
