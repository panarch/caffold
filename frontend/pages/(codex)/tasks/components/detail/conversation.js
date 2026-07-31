import { escapeHtml } from "../../../../../components/dom.js";
import { formatDuration } from "../../task-format.js";
import { pendingApprovals } from "../../task-events.js";
import { isTaskTransportStale } from "../../runtime-state.js";
import "./conversation/markdown.js";
import { renderConversation } from "./conversation/render.js";

class CaffoldTaskConversation extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.addEventListener("scroll", this.boundScroll, true);
    this.addEventListener(
      "caffold:task-markdown-rendered",
      this.boundMarkdownRendered,
    );
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("scroll", this.boundScroll, true);
    this.removeEventListener(
      "caffold:task-markdown-rendered",
      this.boundMarkdownRendered,
    );
    this.disconnectResizeObserver();
    this.stopActiveTurnClock();
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
    this.scrollByThread = new Map();
    this.disclosureByThread = new Map();
    this.resizeObserver = null;
    this.activeTurnClockTimer = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundScroll = (event) => {
      if (event.target === this.scroller()) {
        this.handleScroll();
      }
    };
    this.boundMarkdownRendered = (event) =>
      this.handleMarkdownRendered(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const previousThreadId = this.snapshot.threadId;
    const previousScroll = this.rememberScroll(previousThreadId);
    this.snapshot = {
      ...this.snapshot,
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
    const storedScroll = this.scrollByThread.get(this.snapshot.threadId) ?? null;
    this.render(
      previousThreadId === this.snapshot.threadId
        ? previousScroll ?? storedScroll
        : storedScroll,
    );
  }

  scroller() {
    return this.querySelector(":scope > .task-conversation-scroll");
  }

  hasScrollSnapshot(threadId) {
    this.ensureState();
    return this.scrollByThread.has(`${threadId ?? ""}`);
  }

  render(previousScroll = null) {
    this.ensureState();
    this.dataset.transportState = this.snapshot.transportState;
    const { task } = this.snapshot;
    if (!task) {
      this.innerHTML = "";
      this.disconnectResizeObserver();
      this.stopActiveTurnClock();
      return;
    }
    const approvals = pendingApprovals(this.snapshot.events);
    const controlsDisabled = isTaskTransportStale(
      this.snapshot.transportState,
    );
    this.innerHTML = `
      <div class="task-conversation-scroll">
        <div class="task-conversation-column">
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
          <ol class="task-conversation" aria-label="Task conversation">
            ${renderConversation(this.snapshot.events, task, approvals, {
              controlsDisabled,
            })}
          </ol>
        </div>
      </div>
    `;
    this.restoreDisclosureState();
    this.restoreScroll(previousScroll);
    this.bindResizeObserver();
    this.syncActiveTurnClock();
    this.rememberScroll();
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
        let state = this.disclosureByThread.get(this.snapshot.threadId);
        if (!state) {
          state = new Map();
          this.disclosureByThread.set(this.snapshot.threadId, state);
        }
        state.set(key, !disclosure.open);
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
      });
    } else if (action.dataset.conversationAction === "retry-history") {
      this.dispatchIntent("older-history", { retry: true });
    } else if (action.dataset.conversationAction === "retry-detail") {
      this.dispatchIntent("retry-detail");
    }
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

  bindResizeObserver() {
    this.disconnectResizeObserver();
    const scroller = this.scroller();
    const column = scroller?.querySelector(".task-conversation-column");
    const threadId = this.snapshot.threadId;
    if (
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
      const previousScroll = this.scrollByThread.get(threadId);
      if (!previousScroll) {
        return;
      }
      if (previousScroll.atBottom) {
        scroller.scrollTop = maxScrollTop(scroller);
      } else {
        this.restoreAnchor(scroller, previousScroll);
      }
      this.rememberScroll(threadId);
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
    const previousScroll = this.scrollByThread.get(this.snapshot.threadId);
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

  syncActiveTurnClock() {
    const activeTurn = this.querySelector("[data-active-turn-started-ms]");
    if (!activeTurn) {
      this.stopActiveTurnClock();
      return;
    }
    this.updateActiveTurnClock();
    if (!this.activeTurnClockTimer) {
      this.activeTurnClockTimer = window.setInterval(
        () => this.updateActiveTurnClock(),
        1_000,
      );
    }
  }

  updateActiveTurnClock() {
    const activeTurn = this.querySelector("[data-active-turn-started-ms]");
    const duration = activeTurn?.querySelector(".task-turn-active-duration");
    const startedMs = Number(activeTurn?.dataset.activeTurnStartedMs);
    if (!activeTurn || !duration || !Number.isFinite(startedMs)) {
      this.stopActiveTurnClock();
      return;
    }
    duration.textContent = `Working for ${formatDuration(
      Date.now() - startedMs,
    )}`;
  }

  stopActiveTurnClock() {
    window.clearInterval(this.activeTurnClockTimer);
    this.activeTurnClockTimer = null;
  }
}

function isScrolledToBottom(element) {
  return maxScrollTop(element) - element.scrollTop <= 8;
}

function maxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

if (!customElements.get("caffold-task-conversation")) {
  customElements.define(
    "caffold-task-conversation",
    CaffoldTaskConversation,
  );
}
