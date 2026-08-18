import { escapeHtml } from "../../../../../../components/dom.js";
import {
  dedupeCanonicalEvents,
  eventIdentityKey,
  pendingApprovals,
} from "../../../task-events.js";
import { isTaskTransportStale } from "../../../runtime-state.js";
import { requestTaskImagePreview } from "../../../components/image-preview-dialog.js";
import "./conversation/components/active-turn.js";
import "./conversation/components/changed-files.js";
import "./conversation/components/command.js";
import "./conversation/components/markdown.js";
import "./conversation/components/work-details.js";
import { renderConversation } from "./conversation/render.js";

class CaffoldTaskConversation extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.active = true;
    this.addEventListener("click", this.boundClick);
    this.addEventListener("scroll", this.boundScroll, true);
    this.addEventListener(
      "caffold:task-markdown-rendered",
      this.boundMarkdownRendered,
    );
    this.addEventListener(
      "caffold:task-work-details-disclosure-intent",
      this.boundWorkDetailsDisclosureIntent,
    );
    this.addEventListener(
      "caffold:task-command-intent",
      this.boundCommandIntent,
    );
    this.addEventListener(
      "caffold:task-command-disclosure-intent",
      this.boundCommandDisclosureIntent,
    );
    this.render();
  }

  disconnectedCallback() {
    this.rememberScroll();
    this.active = false;
    this.pendingDisclosureAnchorByThread.delete(this.snapshot.threadId);
    this.pendingMarkdownScrollByThread.delete(this.snapshot.threadId);
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("scroll", this.boundScroll, true);
    this.removeEventListener(
      "caffold:task-markdown-rendered",
      this.boundMarkdownRendered,
    );
    this.removeEventListener(
      "caffold:task-work-details-disclosure-intent",
      this.boundWorkDetailsDisclosureIntent,
    );
    this.removeEventListener(
      "caffold:task-command-intent",
      this.boundCommandIntent,
    );
    this.removeEventListener(
      "caffold:task-command-disclosure-intent",
      this.boundCommandDisclosureIntent,
    );
    this.disconnectResizeObserver();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      threadId: "",
      task: null,
      events: [],
      eventsPage: { nextCursor: null },
      loading: false,
      loadingOlder: false,
      detailError: null,
      historyError: null,
      transportState: "idle",
      updateKind: null,
    };
    this.approvalErrors = new Map();
    this.scrollByThread = new Map();
    this.disclosureByThread = new Map();
    this.pendingDisclosureAnchorByThread = new Map();
    this.pendingMarkdownScrollByThread = new Map();
    this.resizeObserver = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundScroll = (event) => {
      if (event.target === this.scroller()) {
        this.handleScroll();
      }
    };
    this.boundMarkdownRendered = (event) =>
      this.handleMarkdownRendered(event);
    this.boundWorkDetailsDisclosureIntent = (event) =>
      this.handleWorkDetailsDisclosureIntent(event);
    this.boundCommandIntent = (event) => this.handleCommandIntent(event);
    this.boundCommandDisclosureIntent = (event) =>
      this.handleCommandDisclosureIntent(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const previousSnapshot = this.snapshot;
    const previousThreadId = previousSnapshot.threadId;
    const nextSnapshot = {
      ...previousSnapshot,
      ...snapshot,
      threadId: `${snapshot.threadId ?? ""}`,
      task: snapshot.task ?? null,
      events: [...(snapshot.events ?? [])],
      eventsPage: snapshot.eventsPage ?? { nextCursor: null },
      loading: Boolean(snapshot.loading),
      loadingOlder: Boolean(snapshot.loadingOlder),
      detailError: snapshot.detailError ?? null,
      historyError: snapshot.historyError ?? null,
      transportState: snapshot.transportState ?? "idle",
      updateKind: snapshot.updateKind ?? null,
    };
    if (sameConversationSnapshot(previousSnapshot, nextSnapshot)) {
      this.snapshot = {
        ...previousSnapshot,
        updateKind: nextSnapshot.updateKind,
      };
      if (nextSnapshot.updateKind === "bottom") {
        const scroller = this.scroller();
        if (scroller) {
          scroller.scrollTop = maxScrollTop(scroller);
          this.rememberScroll();
        }
      }
      return false;
    }
    const previousScroll =
      this.pendingMarkdownScrollByThread.get(previousThreadId) ??
      this.rememberScroll(previousThreadId);
    const nextThreadId = nextSnapshot.threadId;
    if (previousThreadId !== nextThreadId) {
      this.approvalErrors.clear();
      this.pendingDisclosureAnchorByThread.delete(previousThreadId);
      this.pendingMarkdownScrollByThread.delete(previousThreadId);
    }
    this.snapshot = nextSnapshot;
    this.pruneApprovalErrors();
    const storedScroll = this.scrollByThread.get(this.snapshot.threadId) ?? null;
    this.render(
      previousThreadId === this.snapshot.threadId
        ? previousScroll ?? storedScroll
        : storedScroll,
    );
    return true;
  }

  setApprovalError(approvalId, error) {
    this.ensureState();
    const id = `${approvalId ?? ""}`.trim();
    if (!id) {
      return;
    }
    const previousScroll = this.rememberScroll();
    const pending = pendingApprovals(this.snapshot.events).some(
      (event) => event.payload?.approvalId === id,
    );
    if (error && pending) {
      this.approvalErrors.set(id, error);
    } else {
      this.approvalErrors.delete(id);
    }
    this.render(previousScroll);
  }

  pruneApprovalErrors() {
    const pendingIds = new Set(
      pendingApprovals(this.snapshot.events)
        .map((event) => `${event.payload?.approvalId ?? ""}`.trim())
        .filter(Boolean),
    );
    for (const approvalId of this.approvalErrors.keys()) {
      if (!pendingIds.has(approvalId)) {
        this.approvalErrors.delete(approvalId);
      }
    }
  }

  scroller() {
    return this.querySelector(":scope > .task-conversation-scroll");
  }

  conversationList() {
    return this.scroller()?.querySelector(":scope .task-conversation") ?? null;
  }

  activeTurn() {
    return (
      this.conversationList()?.querySelector(
        ":scope > .task-turn-active > caffold-task-active-turn",
      ) ?? null
    );
  }

  hasScrollSnapshot(threadId) {
    this.ensureState();
    return this.scrollByThread.has(`${threadId ?? ""}`);
  }

  setActive(active) {
    this.ensureState();
    const nextActive = Boolean(active);
    if (this.active === nextActive) {
      return;
    }
    if (!nextActive) {
      this.rememberScroll();
      this.active = false;
      this.pendingDisclosureAnchorByThread.delete(this.snapshot.threadId);
      this.pendingMarkdownScrollByThread.delete(this.snapshot.threadId);
      this.disconnectResizeObserver();
      this.activeTurn()?.setActive(false);
      return;
    }
    this.active = true;
    this.reconcileViewportResize();
    this.bindResizeObserver();
    this.activeTurn()?.setActive(true);
  }

  reconcileViewportResize() {
    const scroller = this.scroller();
    const previousScroll = this.scrollByThread.get(this.snapshot.threadId);
    if (!scroller || !previousScroll) {
      return;
    }
    if (previousScroll.atBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
    } else {
      this.restoreAnchor(scroller, previousScroll);
    }
    this.rememberScroll();
  }

  render(previousScroll = null) {
    this.ensureState();
    this.dataset.transportState = this.snapshot.transportState;
    const { task } = this.snapshot;
    if (!task) {
      this.pendingDisclosureAnchorByThread.delete(this.snapshot.threadId);
      this.pendingMarkdownScrollByThread.delete(this.snapshot.threadId);
      this.innerHTML = "";
      this.disconnectResizeObserver();
      return;
    }
    const approvals = pendingApprovals(this.snapshot.events);
    const controlsDisabled = isTaskTransportStale(
      this.snapshot.transportState,
    );
    this.ensureShell();
    this.renderNotices();
    const view = renderConversation(this.snapshot.events, task, approvals, {
      controlsDisabled,
      approvalErrors: this.approvalErrors,
    });
    reconcileConversationList(
      this.conversationList(),
      view.html,
      view.activeTurns,
      view.workDetails,
      view.changedFiles,
      view.commands,
      this.active,
    );
    const threadId = this.snapshot.threadId;
    const hasPendingMarkdown = this.hasPendingMarkdownRender();
    if (hasPendingMarkdown && previousScroll && !previousScroll.atBottom) {
      this.pendingMarkdownScrollByThread.set(threadId, previousScroll);
    } else if (!hasPendingMarkdown) {
      this.pendingMarkdownScrollByThread.delete(threadId);
    }
    const scrollToRestore =
      this.pendingMarkdownScrollByThread.get(threadId) ?? previousScroll;
    this.restoreDisclosureState();
    this.restoreScroll(scrollToRestore);
    this.restorePendingDisclosureAnchor(
      this.scroller(),
      this.snapshot.threadId,
    );
    this.bindResizeObserver();
    if (!this.pendingMarkdownScrollByThread.has(threadId)) {
      this.rememberScroll();
    }
  }

  ensureShell() {
    if (this.scroller()) {
      return;
    }
    this.innerHTML = `
      <div class="task-conversation-scroll">
        <div class="task-conversation-column">
          <div class="task-conversation-notices"></div>
          <ol class="task-conversation" aria-label="Task conversation"></ol>
        </div>
      </div>
    `;
  }

  renderNotices() {
    const notices = this.querySelector(".task-conversation-notices");
    notices.innerHTML = `
      ${
        this.snapshot.detailError
          ? `<div class="task-detail-load-error task-detail-load-error-inline" role="alert">
              <p>Task details could not be refreshed.</p>
              <p class="task-load-error-message">${escapeHtml(this.snapshot.detailError.message)}</p>
              <button type="button" class="task-secondary-button" data-task-action="retry-task-detail" data-conversation-action="retry-detail">Retry</button>
            </div>`
          : ""
      }
      ${
        this.snapshot.loading
          ? `<p class="task-history-loading" role="status">Loading conversation...</p>`
          : ""
      }
      ${
        this.snapshot.eventsPage?.nextCursor || this.snapshot.loadingOlder
          ? `<div class="task-load-older">
              ${this.snapshot.loadingOlder ? "Loading older..." : ""}
              ${
                this.snapshot.historyError
                  ? `<div class="task-history-error" role="alert">
                      <span>Older messages are temporarily unavailable.</span>
                      <span class="task-load-error-message">${escapeHtml(this.snapshot.historyError.message)}</span>
                      <button type="button" data-task-action="retry-task-history" data-conversation-action="retry-history">Retry loading older messages</button>
                    </div>`
                  : ""
              }
            </div>`
          : ""
      }
    `;
  }

  handleClick(event) {
    const disclosureSummary =
      event.target instanceof Element
        ? event.target.closest(
            ".task-conversation details[data-disclosure-key] > summary",
          )
        : null;
    const disclosure = disclosureSummary?.parentElement;
    if (disclosure instanceof HTMLDetailsElement) {
      const key = `${disclosure.dataset.disclosureKey ?? ""}`.trim();
      if (key && this.snapshot.threadId) {
        const nextOpen = !disclosure.open;
        this.captureDisclosureAnchor(key, disclosureSummary, nextOpen);
        let state = this.disclosureByThread.get(this.snapshot.threadId);
        if (!state) {
          state = new Map();
          this.disclosureByThread.set(this.snapshot.threadId, state);
        }
        state.set(key, nextOpen);
      }
    }

    const action =
      event.target instanceof Element
        ? event.target.closest(
            "[data-conversation-action], .task-approval-card [data-task-action='approval']",
          )
        : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    if (action.dataset.taskAction === "approval") {
      this.dispatchIntent("approval", {
        approvalId: action.dataset.approvalId,
        decision: action.dataset.decision,
        scope: action.dataset.scope,
      });
    } else if (action.dataset.conversationAction === "retry-history") {
      this.dispatchIntent("older-history", { retry: true });
    } else if (action.dataset.conversationAction === "retry-detail") {
      this.dispatchIntent("retry-detail");
    } else if (action.dataset.conversationAction === "preview-image") {
      const image = action.querySelector("img");
      requestTaskImagePreview(this, {
        src: image?.getAttribute("src"),
        name: action.dataset.imageName,
      });
    }
  }

  handleCommandIntent(event) {
    const owner = event.target;
    if (
      !(owner instanceof HTMLElement) ||
      owner.localName !== "caffold-task-command" ||
      !this.contains(owner)
    ) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type !== "command-output") {
      return;
    }
    const commandKey = `${event.detail.commandKey ?? ""}`;
    const command = dedupeCanonicalEvents(this.snapshot.events).find(
      (entry) =>
        entry.type === "command_execution" &&
        eventIdentityKey(entry) === commandKey,
    );
    if (command) {
      this.dispatchIntent("command-output", { command });
    }
  }

  handleCommandDisclosureIntent(event) {
    const owner = event.target;
    if (
      !(owner instanceof HTMLElement) ||
      owner.localName !== "caffold-task-command" ||
      !this.contains(owner)
    ) {
      return;
    }
    event.stopPropagation();
    const commandKey = `${event.detail?.commandKey ?? ""}`;
    if (!commandKey) {
      return;
    }
    this.captureCommandAnchor(
      owner,
      commandKey,
      Boolean(event.detail?.open),
    );
  }

  handleWorkDetailsDisclosureIntent(event) {
    const owner = event.target;
    if (
      !(owner instanceof HTMLElement) ||
      owner.localName !== "caffold-task-work-details" ||
      !this.contains(owner)
    ) {
      return;
    }
    event.stopPropagation();
    const identity = `${event.detail?.identity ?? ""}`;
    const key = `${event.detail?.key ?? ""}`;
    if (!identity || !key) {
      return;
    }
    this.captureWorkDetailsAnchor(
      owner,
      identity,
      key,
      Boolean(event.detail?.open),
    );
  }

  handleScroll() {
    const scroller = this.scroller();
    this.rememberScroll();
    if (
      !scroller ||
      this.snapshot.loadingOlder ||
      this.snapshot.historyError ||
      !this.snapshot.eventsPage?.nextCursor ||
      scroller.scrollTop > 32
    ) {
      return;
    }
    this.dispatchIntent("older-history");
  }

  dispatchIntent(type, detail = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-conversation-intent", {
        bubbles: true,
        composed: true,
        detail: { type, ...detail },
      }),
    );
  }

  captureScroll() {
    const scroller = this.scroller();
    if (!scroller || scroller.clientHeight === 0) {
      return null;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const events = [...scroller.querySelectorAll(".task-event[data-event-id]")];
    const anchor =
      events.find((event) => {
        const rect = event.getBoundingClientRect();
        return (
          rect.top >= scrollerRect.top + 1 &&
          rect.top < scrollerRect.bottom - 1
        );
      }) ??
      events.find(
        (event) =>
          event.getBoundingClientRect().bottom > scrollerRect.top + 1,
      );
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: isScrolledToBottom(scroller),
      anchorEventId: anchor?.dataset.eventId ?? "",
      anchorOffset: anchor
        ? anchor.getBoundingClientRect().top - scrollerRect.top
        : null,
    };
  }

  rememberScroll(threadId = this.snapshot.threadId) {
    const scroll = this.captureScroll();
    if (scroll && threadId) {
      this.scrollByThread.set(threadId, scroll);
    }
    return scroll;
  }

  restoreScroll(previousScroll) {
    const scroller = this.scroller();
    if (!scroller) {
      return;
    }
    const kind = this.snapshot.updateKind;
    const firstSnapshot = !previousScroll;
    const shouldStickToBottom =
      firstSnapshot ||
      kind === "bottom" ||
      (kind === "live" && previousScroll?.atBottom) ||
      (!kind && previousScroll?.atBottom);
    if (shouldStickToBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
      return;
    }
    if (kind === "prepend" && previousScroll) {
      if (this.restoreAnchor(scroller, previousScroll)) {
        return;
      }
      scroller.scrollTop = Math.min(
        previousScroll.scrollTop +
          (scroller.scrollHeight - previousScroll.scrollHeight),
        maxScrollTop(scroller),
      );
      return;
    }
    if (this.restoreAnchor(scroller, previousScroll)) {
      return;
    }
    if (previousScroll) {
      scroller.scrollTop = Math.min(
        previousScroll.scrollTop,
        maxScrollTop(scroller),
      );
    }
  }

  restoreAnchor(scroller, previousScroll) {
    if (
      !previousScroll?.anchorEventId ||
      !Number.isFinite(previousScroll.anchorOffset)
    ) {
      return false;
    }
    const anchor = [
      ...scroller.querySelectorAll(".task-event[data-event-id]"),
    ].find(
      (event) => event.dataset.eventId === previousScroll.anchorEventId,
    );
    if (!anchor) {
      return false;
    }
    const currentOffset =
      anchor.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.min(
      Math.max(
        0,
        scroller.scrollTop +
          currentOffset -
          previousScroll.anchorOffset,
      ),
      maxScrollTop(scroller),
    );
    return true;
  }

  captureDisclosureAnchor(key, summary, open) {
    const scroller = this.scroller();
    const threadId = this.snapshot.threadId;
    if (!scroller || !threadId || !scroller.contains(summary)) {
      return;
    }
    const offset =
      summary.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top;
    this.pendingDisclosureAnchorByThread.set(threadId, {
      owner: "conversation",
      key,
      open,
      offset,
    });
    window.requestAnimationFrame(() => {
      const currentScroller = this.scroller();
      if (
        this.snapshot.threadId === threadId &&
        this.restorePendingDisclosureAnchor(currentScroller, threadId)
      ) {
        this.rememberScroll(threadId);
      }
    });
  }

  captureWorkDetailsAnchor(owner, identity, key, open) {
    const scroller = this.scroller();
    const threadId = this.snapshot.threadId;
    const anchorTop = owner.disclosureAnchorTop(key);
    if (
      !scroller ||
      !threadId ||
      !scroller.contains(owner) ||
      !Number.isFinite(anchorTop)
    ) {
      return;
    }
    const offset = anchorTop - scroller.getBoundingClientRect().top;
    this.pendingDisclosureAnchorByThread.set(threadId, {
      owner: "work-details",
      identity,
      key,
      open,
      offset,
    });
    window.requestAnimationFrame(() => {
      const currentScroller = this.scroller();
      if (
        this.snapshot.threadId === threadId &&
        this.restorePendingDisclosureAnchor(currentScroller, threadId)
      ) {
        this.rememberScroll(threadId);
      }
    });
  }

  captureCommandAnchor(owner, commandKey, open) {
    const scroller = this.scroller();
    const threadId = this.snapshot.threadId;
    const anchorTop = owner.disclosureAnchorTop();
    if (
      !scroller ||
      !threadId ||
      !scroller.contains(owner) ||
      !Number.isFinite(anchorTop)
    ) {
      return;
    }
    const offset = anchorTop - scroller.getBoundingClientRect().top;
    this.pendingDisclosureAnchorByThread.set(threadId, {
      owner: "command",
      commandKey,
      open,
      offset,
    });
    window.requestAnimationFrame(() => {
      const currentScroller = this.scroller();
      if (
        this.snapshot.threadId === threadId &&
        this.restorePendingDisclosureAnchor(currentScroller, threadId)
      ) {
        this.rememberScroll(threadId);
      }
    });
  }

  restorePendingDisclosureAnchor(scroller, threadId) {
    const pending = this.pendingDisclosureAnchorByThread.get(threadId);
    if (!scroller || !pending) {
      return false;
    }
    let currentTop = null;
    let currentOpen = false;
    if (pending.owner === "work-details") {
      const owner = [
        ...scroller.querySelectorAll("caffold-task-work-details"),
      ].find((entry) => entry.identity === pending.identity);
      if (!owner) {
        this.pendingDisclosureAnchorByThread.delete(threadId);
        return false;
      }
      currentOpen = owner.disclosureOpen(pending.key);
      currentTop = owner.disclosureAnchorTop(pending.key);
    } else if (pending.owner === "command") {
      const owner = [...scroller.querySelectorAll("caffold-task-command")].find(
        (entry) => entry.commandKey === pending.commandKey,
      );
      if (!owner) {
        this.pendingDisclosureAnchorByThread.delete(threadId);
        return false;
      }
      currentOpen = owner.disclosureOpen();
      currentTop = owner.disclosureAnchorTop();
    } else {
      const disclosure = [
        ...scroller.querySelectorAll("details[data-disclosure-key]"),
      ].find((entry) => entry.dataset.disclosureKey === pending.key);
      if (!disclosure) {
        this.pendingDisclosureAnchorByThread.delete(threadId);
        return false;
      }
      currentOpen = disclosure.open;
      currentTop = disclosure
        .querySelector(":scope > summary")
        ?.getBoundingClientRect().top;
    }
    if (currentOpen !== pending.open) {
      return false;
    }
    if (!Number.isFinite(currentTop)) {
      this.pendingDisclosureAnchorByThread.delete(threadId);
      return false;
    }
    const currentOffset = currentTop - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.min(
      Math.max(0, scroller.scrollTop + currentOffset - pending.offset),
      maxScrollTop(scroller),
    );
    this.pendingDisclosureAnchorByThread.delete(threadId);
    return true;
  }

  restoreDisclosureState() {
    const state = this.disclosureByThread.get(this.snapshot.threadId);
    if (!state) {
      return;
    }
    this.querySelectorAll(
      ".task-conversation details[data-disclosure-key]",
    ).forEach((disclosure) => {
      const key = disclosure.dataset.disclosureKey;
      if (state.has(key)) {
        disclosure.toggleAttribute("open", state.get(key));
      }
    });
  }

  hasPendingMarkdownRender() {
    return Boolean(
      this.conversationList()?.querySelector(
        'caffold-task-markdown[data-render-state="loading"]',
      ),
    );
  }

  bindResizeObserver() {
    this.disconnectResizeObserver();
    const scroller = this.scroller();
    const column = scroller?.querySelector(".task-conversation-column");
    const threadId = this.snapshot.threadId;
    if (
      !this.active ||
      !scroller ||
      !column ||
      !threadId ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      if (this.scroller() !== scroller) {
        return;
      }
      const pendingMarkdownScroll =
        this.pendingMarkdownScrollByThread.get(threadId);
      const previousScroll =
        pendingMarkdownScroll ?? this.scrollByThread.get(threadId);
      if (!previousScroll) {
        return;
      }
      if (this.restorePendingDisclosureAnchor(scroller, threadId)) {
        // A user-controlled disclosure owns this one layout change.
      } else if (previousScroll.atBottom) {
        scroller.scrollTop = maxScrollTop(scroller);
      } else {
        this.restoreAnchor(scroller, previousScroll);
      }
      if (!pendingMarkdownScroll) {
        this.rememberScroll(threadId);
      }
    });
    this.resizeObserver.observe(column);
  }

  disconnectResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  handleMarkdownRendered(event) {
    const scroller = this.scroller();
    if (!scroller || !event.detail) {
      return;
    }
    event.stopPropagation();
    const threadId = this.snapshot.threadId;
    const pendingMarkdownScroll =
      this.pendingMarkdownScrollByThread.get(threadId);
    const previousScroll =
      pendingMarkdownScroll ?? this.scrollByThread.get(threadId);
    if (pendingMarkdownScroll) {
      this.restoreScroll(pendingMarkdownScroll);
      if (!this.hasPendingMarkdownRender()) {
        this.pendingMarkdownScrollByThread.delete(threadId);
        this.rememberScroll(threadId);
      }
      return;
    }
    if (event.detail.atBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
    } else if (this.restoreAnchor(scroller, previousScroll)) {
      // Preserve the current event while Markdown replaces fallback text.
    } else if (
      event.detail.aboveViewport &&
      Number.isFinite(event.detail.scrollHeight) &&
      Number.isFinite(event.detail.nextScrollHeight) &&
      Number.isFinite(event.detail.scrollTop)
    ) {
      scroller.scrollTop = Math.min(
        event.detail.scrollTop +
          (event.detail.nextScrollHeight - event.detail.scrollHeight),
        maxScrollTop(scroller),
      );
    }
    this.rememberScroll();
  }
}

function reconcileConversationList(
  list,
  html,
  activeTurns,
  workDetails,
  changedFiles = new Map(),
  commands = new Map(),
  active = true,
) {
  if (!list) {
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const existingWorkEntries = new Map(
    [...list.children]
      .filter((entry) =>
        entry.matches(".task-turn-work[data-conversation-entry-key]"),
      )
      .map((entry) => [entry.dataset.conversationEntryKey, entry]),
  );
  const existingStableEntries = new Map(
    [...list.children]
      .filter(
        (entry) =>
          entry.matches(
            ".task-message[data-conversation-entry-key][data-conversation-entry-version], .task-thinking[data-conversation-entry-key][data-conversation-entry-version]",
          ),
      )
      .map((entry) => [entry.dataset.conversationEntryKey, entry]),
  );
  const existingFileChangeEntries = new Map(
    [...list.children]
      .filter((entry) =>
        entry.matches(".task-file-change[data-conversation-entry-key]"),
      )
      .map((entry) => [entry.dataset.conversationEntryKey, entry]),
  );
  const existingCommandEntries = new Map(
    [...list.children]
      .filter((entry) =>
        entry.matches(".task-command[data-conversation-entry-key]"),
      )
      .map((entry) => [entry.dataset.conversationEntryKey, entry]),
  );
  const existingActiveTurn = list.querySelector(
    ":scope > .task-turn-active[data-conversation-entry-key]",
  );
  const desiredEntries = [...template.content.children].map((entry) => {
    const key = `${entry.dataset.conversationEntryKey ?? ""}`;
    if (!key) {
      return entry;
    }
    const stable = existingStableEntries.get(key);
    if (
      stable &&
      stable.dataset.conversationEntryVersion ===
        entry.dataset.conversationEntryVersion
    ) {
      return stable;
    }
    if (
      entry.matches(".task-turn-active") &&
      existingActiveTurn?.dataset.conversationEntryKey === key &&
      existingActiveTurn.querySelector(
        ":scope > caffold-task-active-turn",
      ) &&
      activeTurns.has(key)
    ) {
      syncElementAttributes(existingActiveTurn, entry, [
        "class",
        "data-active-turn-started-ms",
        "data-turn-id",
        "data-conversation-entry-key",
      ]);
      return existingActiveTurn;
    }
    const commandSnapshot = commands.get(key);
    const existingCommand = existingCommandEntries.get(key);
    if (
      commandSnapshot &&
      existingCommand &&
      patchCommandEntry(existingCommand, entry)
    ) {
      return existingCommand;
    }
    const changedFileSnapshot = changedFiles.get(key);
    const existingFileChange = existingFileChangeEntries.get(key);
    if (
      changedFileSnapshot &&
      existingFileChange &&
      patchFileChangeEntry(existingFileChange, entry)
    ) {
      return existingFileChange;
    }
    const snapshot = workDetails.get(key);
    const existing = existingWorkEntries.get(key);
    const owner = existing?.querySelector(
      ":scope > caffold-task-work-details",
    );
    if (existing && owner && snapshot) {
      existing.dataset.turnId = entry.dataset.turnId;
      return existing;
    }
    return entry;
  });
  reconcileElementChildren(list, desiredEntries);
  for (const entry of desiredEntries) {
    const key = `${entry.dataset.conversationEntryKey ?? ""}`;
    const activeTurnSnapshot = activeTurns.get(key);
    const activeTurnOwner = entry.querySelector(
      ":scope > caffold-task-active-turn",
    );
    if (activeTurnOwner && activeTurnSnapshot) {
      activeTurnOwner.setSnapshot(activeTurnSnapshot);
      activeTurnOwner.setActive(active);
    }
    const snapshot = workDetails.get(key);
    const owner = entry.querySelector(
      ":scope > caffold-task-work-details",
    );
    if (owner && snapshot) {
      owner.setSnapshot(snapshot);
    }
    const changedFileSnapshot = changedFiles.get(key);
    const changedFileOwner = entry.querySelector(
      ":scope > article > caffold-task-changed-files",
    );
    if (changedFileOwner && changedFileSnapshot) {
      changedFileOwner.setSnapshot(changedFileSnapshot);
    }
    const commandSnapshot = commands.get(key);
    const commandOwner = entry.querySelector(":scope > caffold-task-command");
    if (commandOwner && commandSnapshot) {
      commandOwner.setSnapshot(commandSnapshot);
    }
  }
}

function patchCommandEntry(current, desired) {
  const owner = current.querySelector(":scope > caffold-task-command");
  if (!owner) {
    return false;
  }
  syncElementAttributes(current, desired, [
    "class",
    "data-event-id",
    "data-conversation-entry-key",
    "data-event-type",
  ]);
  return true;
}

function patchFileChangeEntry(current, desired) {
  const currentTime = current.querySelector(":scope > article > header > time");
  const desiredTime = desired.querySelector(":scope > article > header > time");
  const currentSummary = current.querySelector(":scope > article > p");
  const desiredSummary = desired.querySelector(":scope > article > p");
  const owner = current.querySelector(
    ":scope > article > caffold-task-changed-files",
  );
  if (
    !currentTime ||
    !desiredTime ||
    !currentSummary ||
    !desiredSummary ||
    !owner
  ) {
    return false;
  }
  syncElementAttributes(current, desired, [
    "class",
    "data-event-id",
    "data-conversation-entry-key",
    "data-event-type",
  ]);
  patchText(currentTime, desiredTime.textContent);
  patchText(currentSummary, desiredSummary.textContent);
  return true;
}

function syncElementAttributes(current, desired, names) {
  for (const name of names) {
    if (desired.hasAttribute(name)) {
      const value = desired.getAttribute(name);
      if (current.getAttribute(name) === value) {
        continue;
      }
      current.setAttribute(name, value);
    } else if (current.hasAttribute(name)) {
      current.removeAttribute(name);
    }
  }
}

function patchText(element, value) {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

function reconcileElementChildren(parent, desiredChildren) {
  const desired = new Set(desiredChildren);
  for (const child of [...parent.children]) {
    if (!desired.has(child)) {
      child.remove();
    }
  }

  // Reconcile from the stable tail so stateful entries are not detached while
  // older timeline entries ahead of them are replaced.
  let anchor = null;
  for (let index = desiredChildren.length - 1; index >= 0; index -= 1) {
    const child = desiredChildren[index];
    if (child.parentElement !== parent || child.nextElementSibling !== anchor) {
      parent.insertBefore(child, anchor);
    }
    anchor = child;
  }
}

function isScrolledToBottom(element) {
  return maxScrollTop(element) - element.scrollTop <= 8;
}

function maxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function sameConversationSnapshot(left, right) {
  return Boolean(
    left &&
      right &&
      left.threadId === right.threadId &&
      left.task === right.task &&
      sameEventList(left.events, right.events) &&
      left.eventsPage?.nextCursor === right.eventsPage?.nextCursor &&
      left.loading === right.loading &&
      left.loadingOlder === right.loadingOlder &&
      left.detailError === right.detailError &&
      left.historyError === right.historyError &&
      left.transportState === right.transportState
  );
}

function sameEventList(left = [], right = []) {
  return (
    left.length === right.length &&
    left.every((event, index) => event === right[index])
  );
}

if (!customElements.get("caffold-task-conversation")) {
  customElements.define(
    "caffold-task-conversation",
    CaffoldTaskConversation,
  );
}
