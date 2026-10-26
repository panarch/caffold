import { html, LitElement, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { Task, TaskEvent } from "#app/api.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import {
  isTaskTransportStale,
  type TaskTransportState,
} from "#tasks/runtime-state.ts";
import {
  dedupeCanonicalEvents,
  eventIdentityKey,
  pendingApprovals,
} from "#tasks/task-events.ts";
import "./conversation/components/active-turn.ts";
import "./conversation/components/approval.ts";
import type {
  ApprovalIntentDetail,
  CaffoldTaskApproval,
} from "./conversation/components/approval.ts";
import "./conversation/components/assistant-message.ts";
import type {
  CaffoldTaskAssistantMessage,
  SuggestedPromptIntentDetail,
} from "./conversation/components/assistant-message.ts";
import "./conversation/components/changed-files.ts";
import {
  CaffoldTaskCommand,
  type CommandDisclosureIntentDetail,
  type CommandIntentDetail,
} from "./conversation/components/command.ts";
import {
  CaffoldTaskCommandGroup,
  type CommandGroupDisclosureIntentDetail,
} from "./conversation/components/command-group.ts";
import "./conversation/components/markdown.ts";
import type {
  CaffoldTaskMarkdown,
  MarkdownRenderedDetail,
} from "./conversation/components/markdown.ts";
import "./conversation/components/message-attachments.ts";
import type { CaffoldTaskMessageAttachments } from "./conversation/components/message-attachments.ts";
import "./conversation/components/older-history.ts";
import type {
  CaffoldTaskOlderHistory,
  OlderHistoryIntentDetail,
} from "./conversation/components/older-history.ts";
import "./conversation/components/user-message.ts";
import type {
  CaffoldTaskUserMessage,
  UploadProgress,
} from "./conversation/components/user-message.ts";
import {
  CaffoldTaskWorkDetails,
  type WorkDetailsDisclosureIntentDetail,
} from "./conversation/components/work-details.ts";
import {
  type ConversationEntry,
  conversationEntries,
  type ThinkingEntry,
} from "./conversation/entries.ts";

// What the Task screen hands the conversation: the Task, its events, how far
// its history has been read, and how the last change arrived. `updateKind`
// says where the reader should be after it: kept at the bottom, at the bottom
// only if they were there, kept in place above what was prepended, or where
// they were.
export interface ConversationSnapshot {
  threadId: string;
  task: Task | null;
  events: TaskEvent[];
  eventsPage: { nextCursor: string | null };
  loadingOlder: boolean;
  detailError: Error | null;
  historyError: Error | null;
  transportState: TaskTransportState;
  updateKind: "bottom" | "live" | "prepend" | "preserve" | null;
}

// What the conversation asks of the Task screen.
export type ConversationIntent =
  | { type: "retry-detail" }
  | { type: "approval"; approvalId: string; decision: string }
  | { type: "suggested-prompt"; prompt: string }
  | { type: "older-history"; retry?: boolean }
  | { type: "command-output"; command: TaskEvent };

// Where a reader was in the conversation: the first event in view and how far
// from the top it stood, and whether they were at the bottom.
interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atBottom: boolean;
  anchorEventId: string;
  anchorOffset: number | null;
}

// A disclosure the person just toggled, and where its summary stood. Its
// owner opens or closes it after the click; the conversation then moves so the
// summary stays under the pointer.
type DisclosureTarget = { open: boolean } & (
  | { owner: "conversation"; key: string }
  | { owner: "work-details"; identity: string; key: string }
  | { owner: "command"; commandKey: string }
  | { owner: "command-group"; identity: string }
);

type DisclosureAnchor = DisclosureTarget & { offset: number };

// The components a conversation draws, its own and the ones they mount.
const CONVERSATION_COMPONENTS = [
  "caffold-task-active-turn",
  "caffold-task-approval",
  "caffold-task-assistant-message",
  "caffold-task-assistant-message-copy-button",
  "caffold-task-assistant-message-suggested-prompts",
  "caffold-task-changed-files",
  "caffold-task-command",
  "caffold-task-command-group",
  "caffold-task-markdown",
  "caffold-task-markdown-code-block",
  "caffold-task-message-attachments",
  "caffold-task-older-history",
  "caffold-task-user-message",
  "caffold-task-work-details",
].join(", ");

// A Thinking entry's disclosure, its chevron, and its Markdown.
const THINKING = ':scope > details[data-disclosure-key^="thinking:"]';
const THINKING_CHEVRON =
  ":scope > .task-thinking-label > .task-thinking-disclosure-chevron";
const THINKING_MARKDOWN =
  ":scope > details > .task-thinking-content > caffold-task-markdown";

/**
 * A Task's conversation: its entries in order, the row that reads older
 * messages, and the reader's place in it.
 *
 * The Task screen hands it each snapshot, and the conversation draws it at
 * once, entries and all, then keeps the reader's place: at the bottom while new
 * work arrives, on the entry they were reading otherwise, and under the summary
 * of a disclosure they toggled. The Task screen, the keyboard modes, and the
 * place it keeps all read the drawn conversation right after the change, so no
 * part of it is left to draw later.
 */
export class CaffoldTaskConversation extends LitElement {
  snapshot: ConversationSnapshot = {
    threadId: "",
    task: null,
    events: [],
    eventsPage: { nextCursor: null },
    loadingOlder: false,
    detailError: null,
    historyError: null,
    transportState: "idle",
    updateKind: null,
  };
  active = true;
  private scrollByThread = new Map<string, ScrollSnapshot>();
  // Which Thinking disclosures each Task's reader left open or closed.
  private disclosureByThread = new Map<string, Map<string, boolean>>();
  private pendingDisclosureAnchorByThread = new Map<string, DisclosureAnchor>();
  // The place to keep while Markdown is still being drawn.
  private pendingMarkdownScrollByThread = new Map<string, ScrollSnapshot>();
  // How far a message's files have gone up. It is kept here to hand to a
  // message drawn anew, as when its Task is opened again mid-upload.
  private uploadProgressByEvent = new Map<string, UploadProgress>();
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.active = true;
    this.draw(null);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.rememberScroll();
    this.active = false;
    this.pendingDisclosureAnchorByThread.delete(this.snapshot.threadId);
    this.pendingMarkdownScrollByThread.delete(this.snapshot.threadId);
    this.disconnectResizeObserver();
  }

  setSnapshot(snapshot: Partial<ConversationSnapshot> = {}) {
    const previousSnapshot = this.snapshot;
    const previousThreadId = previousSnapshot.threadId;
    const nextSnapshot: ConversationSnapshot = {
      ...previousSnapshot,
      ...snapshot,
      threadId: snapshot.threadId ?? "",
      task: snapshot.task ?? null,
      events: [...(snapshot.events ?? [])],
      eventsPage: snapshot.eventsPage ?? { nextCursor: null },
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
      this.pendingDisclosureAnchorByThread.delete(previousThreadId);
      this.pendingMarkdownScrollByThread.delete(previousThreadId);
    }
    this.snapshot = nextSnapshot;
    const storedScroll = this.scrollByThread.get(nextThreadId) ?? null;
    this.draw(
      previousThreadId === nextThreadId
        ? (previousScroll ?? storedScroll)
        : storedScroll,
    );
    return true;
  }

  setPromptUploadProgress(eventId: string, progress: UploadProgress | null) {
    if (progress) {
      this.uploadProgressByEvent.set(eventId, progress);
    } else {
      this.uploadProgressByEvent.delete(eventId);
    }
    this.drawNow();
  }

  setApprovalError(approvalId: string, error: Error | null) {
    const card = this.approvalComponents().find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (!card) {
      return;
    }
    const previousScroll = this.rememberScroll();
    card.setError(error);
    this.drawNow();
    this.restoreScroll(previousScroll);
  }

  setActive(active: boolean) {
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
      this.drawNow();
      return;
    }
    this.active = true;
    this.drawNow();
    this.reconcileViewportResize();
    this.bindResizeObserver();
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

  hasScrollSnapshot(threadId: string) {
    return this.scrollByThread.has(threadId);
  }

  render() {
    const { task, threadId, historyError, detailError } = this.snapshot;
    if (!task) {
      return nothing;
    }
    const controlsDisabled = isTaskTransportStale(this.snapshot.transportState);
    const entries = conversationEntries(
      this.snapshot.events,
      task,
      pendingApprovals(this.snapshot.events),
      { controlsDisabled },
    );
    return html`
      <div
        class="task-conversation-scroll"
        @scroll=${this.handleScroll}
        @caffold:task-approval-intent=${this.sendApproval}
        @caffold:task-suggested-prompt-intent=${this.sendSuggestedPrompt}
        @caffold:task-older-history-intent=${this.requestOlderHistory}
        @caffold:task-command-intent=${this.openCommandOutput}
        @caffold:task-command-disclosure-intent=${this.holdCommandAnchor}
        @caffold:task-command-group-disclosure-intent=${this.holdGroupAnchor}
        @caffold:task-work-details-disclosure-intent=${this.holdWorkAnchor}
        @caffold:task-markdown-rendered=${this.handleMarkdownRendered}
      >
        <div class="task-conversation-column">
          <div class="task-conversation-notices">${
            detailError
              ? html`<div
                  class="task-detail-load-error task-detail-load-error-inline"
                  role="alert"
                >
                  <p>Task details could not be refreshed.</p>
                  <p class="task-load-error-message">${detailError.message}</p>
                  <button
                    type="button"
                    class="task-secondary-button"
                    data-task-action="retry-task-detail"
                    data-conversation-action="retry-detail"
                    @click=${this.retryDetail}
                  >Retry</button>
                </div>`
              : nothing
          }</div>
          <caffold-task-older-history
            .threadId=${threadId}
            .hasOlder=${Boolean(this.snapshot.eventsPage.nextCursor)}
            .loading=${this.snapshot.loadingOlder}
            .error=${historyError?.message ?? null}
            .active=${this.active}
          ></caffold-task-older-history>
          <ol class="task-conversation" aria-label="Task conversation">${keyed(
            threadId,
            repeat(
              entries,
              (entry) => entry.identity,
              (entry) => this.entryTemplate(entry, controlsDisabled),
            ),
          )}</ol>
        </div>
      </div>
    `;
  }

  updated() {
    const { transportState } = this.snapshot;
    if (this.dataset.transportState !== transportState) {
      this.dataset.transportState = transportState;
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const scrollport = this.scroller();
    const list = this.conversationList();
    const threadId = this.snapshot.threadId;
    if (
      !scrollport ||
      !list ||
      !threadId ||
      !this.snapshot.task ||
      !this.active ||
      this.hidden
    ) {
      return emptyActionHintScope();
    }
    const targetScopeId = scopeId || `task:${threadId}:conversation`;
    const current = () =>
      this.isConnected &&
      this.active &&
      !this.hidden &&
      this.snapshot.threadId === threadId &&
      Boolean(this.snapshot.task);
    const retrySelector = 'button[data-conversation-action="retry-detail"]';
    const retry = this.querySelector<HTMLButtonElement>(retrySelector);
    const ownTargets =
      retry && !retry.disabled && hasActionHintLayoutBox(retry)
        ? [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: `${targetScopeId}:retry-detail`,
              actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              label:
                retry.getAttribute("aria-label") ||
                retry.title ||
                retry.textContent?.trim() ||
                "retry-detail",
              control: retry,
              clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
              isActionable: () =>
                current() &&
                this.scroller() === scrollport &&
                this.contains(retry) &&
                this.querySelector(retrySelector) === retry &&
                !retry.disabled &&
                hasActionHintLayoutBox(retry),
            }),
          ]
        : [];
    const childScopes: Array<ActionHintScope | undefined> = [];
    const olderHistory = this.olderHistory();
    if (olderHistory) {
      childScopes.push(
        olderHistory.actionHintScope({
          scopeId: `${targetScopeId}:older-history`,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        }),
      );
    }
    const entries = Array.from(list.children);
    const thinkingTargets = entries.flatMap((entry, index) => {
      const identity = entryIdentity(entry, index);
      const childOptions = (kind: string) => ({
        scopeId: `${targetScopeId}:${kind}:${identity}`,
        clipRoots: [this, scrollport, list, ...clipRoots].filter(Boolean),
      });
      for (const card of this.approvalComponents(entry)) {
        childScopes.push(
          card.actionHintScope({
            ...childOptions(`approval:${encodeURIComponent(card.approvalId)}`),
            isCurrent: () =>
              current() && this.approvalComponents().includes(card),
          }),
        );
      }
      childScopes.push(
        entry
          .querySelector<CaffoldTaskCommand>(":scope > caffold-task-command")
          ?.actionHintScope(childOptions("command")),
        entry
          .querySelector<CaffoldTaskCommandGroup>(
            ":scope > caffold-task-command-group",
          )
          ?.actionHintScope(childOptions("command-group")),
        entry
          .querySelector<CaffoldTaskAssistantMessage | CaffoldTaskUserMessage>(
            ":scope > caffold-task-assistant-message, :scope > caffold-task-user-message",
          )
          ?.actionHintScope(childOptions("message")),
        entry
          .querySelector<CaffoldTaskMessageAttachments>(
            ":scope > caffold-task-message-attachments",
          )
          ?.actionHintScope(childOptions("attachments")),
        entry
          .querySelector<CaffoldTaskWorkDetails>(
            ":scope > caffold-task-work-details",
          )
          ?.actionHintScope(childOptions("work-details")),
        entry
          .querySelector<CaffoldTaskMarkdown>(THINKING_MARKDOWN)
          ?.actionHintScope(childOptions("thinking")),
      );
      const disclosure = entry.querySelector<HTMLDetailsElement>(THINKING);
      const summary =
        disclosure?.querySelector<HTMLElement>(":scope > summary");
      const anchor = summary?.querySelector(THINKING_CHEVRON);
      const key = disclosure?.dataset.disclosureKey ?? "";
      if (
        !disclosure ||
        !summary ||
        !anchor ||
        !key.startsWith("thinking:") ||
        !hasActionHintLayoutBox(summary)
      ) {
        return [];
      }
      return [
        disclosureActionHintTarget({
          invalidationOwner: entry,
          id: `${targetScopeId}:thinking:${encodeURIComponent(
            identity,
          )}:${encodeURIComponent(key)}`,
          actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          label: `${disclosure.open ? "Collapse" : "Expand"} Thinking`,
          control: summary,
          anchor,
          clipRoots: [this, scrollport, list, ...clipRoots].filter(Boolean),
          isActionable: () =>
            current() &&
            this.scroller() === scrollport &&
            this.conversationList() === list &&
            Array.from(list.children).includes(entry) &&
            entryIdentity(entry, Array.from(list.children).indexOf(entry)) ===
              identity &&
            entry.querySelector(THINKING) === disclosure &&
            disclosure.dataset.disclosureKey === key &&
            disclosure.querySelector(":scope > summary") === summary &&
            summary.querySelector(THINKING_CHEVRON) === anchor &&
            this.contains(summary) &&
            hasActionHintLayoutBox(summary),
        }),
      ];
    });
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: [...ownTargets, ...thinkingTargets],
        mutationRoots: [this, scrollport],
        scrollRoots: [scrollport],
      },
      ...childScopes,
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.scroller();
    const list = this.conversationList();
    const threadId = this.snapshot.threadId;
    if (!scrollport || !list || !threadId) {
      return emptyScrollSurfaceScope();
    }
    const targetScopeId = scopeId || `task:${threadId}:conversation`;
    const current = () =>
      this.isConnected &&
      this.active &&
      !this.hidden &&
      this.snapshot.threadId === threadId &&
      Boolean(this.snapshot.task) &&
      this.scroller() === scrollport &&
      this.conversationList() === list;
    const ownScope: ScrollSurfaceScope = {
      blocked: false,
      surfaces: [
        {
          id: targetScopeId,
          label: "Conversation",
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            current() &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this, scrollport],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
    const childScopes = Array.from(list.children).flatMap((entry, index) => {
      const identity = entryIdentity(entry, index);
      const childOptions = (kind: string) => ({
        scopeId: `${targetScopeId}:${kind}:${identity}`,
        clipRoots: [this, scrollport, list, ...clipRoots].filter(Boolean),
        isCurrent: () =>
          current() &&
          Array.from(list.children).includes(entry) &&
          entryIdentity(entry, Array.from(list.children).indexOf(entry)) ===
            identity,
      });
      const scopes: Array<ScrollSurfaceScope | undefined> = [];
      const rawOutput = entry.matches(".task-tool-card")
        ? entry.querySelector<HTMLElement>(":scope > pre")
        : null;
      if (rawOutput) {
        const options = childOptions("tool-output");
        scopes.push(
          rawScrollSurfaceScope({
            ...options,
            label: `${
              entry
                .querySelector(":scope > header > strong")
                ?.textContent?.trim() || "Tool"
            } output`,
            scrollport: rawOutput,
            isCurrent: () =>
              options.isCurrent() &&
              entry.matches(".task-tool-card") &&
              entry.querySelector(":scope > pre") === rawOutput,
          }),
        );
      }
      for (const card of this.approvalComponents(entry)) {
        const options = childOptions(
          `approval:${encodeURIComponent(card.approvalId)}`,
        );
        scopes.push(
          card.scrollSurfaceScope({
            ...options,
            isCurrent: () =>
              options.isCurrent() &&
              this.approvalComponents(entry).includes(card),
          }),
        );
      }
      scopes.push(
        entry
          .querySelector<CaffoldTaskCommand>(":scope > caffold-task-command")
          ?.scrollSurfaceScope(childOptions("command")),
        entry
          .querySelector<CaffoldTaskAssistantMessage>(
            ":scope > caffold-task-assistant-message",
          )
          ?.scrollSurfaceScope(childOptions("message")),
        entry
          .querySelector<CaffoldTaskWorkDetails>(
            ":scope > caffold-task-work-details",
          )
          ?.scrollSurfaceScope(childOptions("work-details")),
        entry
          .querySelector<CaffoldTaskMarkdown>(THINKING_MARKDOWN)
          ?.scrollSurfaceScope(childOptions("thinking")),
      );
      return scopes;
    });
    return mergeScrollSurfaceScopes(ownScope, ...childScopes);
  }

  scroller() {
    return this.querySelector<HTMLElement>(
      ":scope > .task-conversation-scroll",
    );
  }

  conversationList() {
    return (
      this.scroller()?.querySelector<HTMLElement>(
        ":scope .task-conversation",
      ) ?? null
    );
  }

  olderHistory() {
    return this.querySelector<CaffoldTaskOlderHistory>(
      ".task-conversation-column > caffold-task-older-history",
    );
  }

  approvalComponents(entry: Element | null = this.conversationList()) {
    return Array.from(
      entry?.querySelectorAll<CaffoldTaskApproval>(
        ":scope > .task-approval-flow > .task-approvals > caffold-task-approval, :scope > .task-approvals > caffold-task-approval",
      ) ?? [],
    );
  }

  private entryTemplate(entry: ConversationEntry, controlsDisabled: boolean) {
    const { threadId } = this.snapshot;
    switch (entry.kind) {
      case "status":
        return html`<li
          class="task-event task-event-status"
          data-event-id=${entry.eventId || nothing}
          data-event-type=${entry.eventType}
          data-event-status=${entry.status}
        >
          <span class="task-status-chip">${entry.summary}</span>
          ${observedTime(entry.time)}
        </li>`;
      case "user-message":
        return html`<li
          class="task-event task-message"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
          data-message-role="user"
        >
          <caffold-task-user-message
            .text=${entry.text}
            .attachments=${entry.attachments}
            .deliveryState=${entry.deliveryState}
            .time=${entry.time}
            .uploadLines=${entry.uploadLines}
            .uploadProgress=${
              this.uploadProgressByEvent.get(entry.eventId) ?? null
            }
          ></caffold-task-user-message>
        </li>`;
      case "generated-image":
        return html`<li
          class="task-event task-message"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
          data-message-role="assistant"
        >
          <div class="task-message-header">${observedTime(entry.time)}</div>
          <caffold-task-message-attachments
            .attachments=${entry.attachments}
          ></caffold-task-message-attachments>
        </li>`;
      case "assistant-message":
        return html`<li
          class="task-event task-assistant-message"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
        >
          <caffold-task-assistant-message
            .event=${entry.event}
            .phase=${entry.phase}
            .turnCompletedMs=${entry.turnCompletedMs}
            .controlsDisabled=${controlsDisabled}
          ></caffold-task-assistant-message>
        </li>`;
      case "thinking":
        return html`<li
          class="task-event task-thinking"
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
          data-thinking-state=${entry.state}
        >
          <details
            ?open=${this.thinkingOpen(entry)}
            data-disclosure-key=${entry.disclosureKey || nothing}
          >
            <summary @click=${this.toggleThinking}>
              <span class="task-thinking-label">
                <span>Thinking</span>
                <span
                  class="task-thinking-disclosure-chevron"
                  aria-hidden="true"
                ></span>
              </span>
              ${observedTime(entry.time)}
            </summary>
            <div class="task-thinking-content">
              <caffold-task-markdown
                thread-id=${entry.threadId || nothing}
                .fileLinks=${entry.fileLinks}
                .markdown=${entry.text}
              ></caffold-task-markdown>
            </div>
          </details>
        </li>`;
      case "tool":
        return html`<li
          class="task-event task-tool-card"
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
          data-tool-tone=${entry.tone}
        >
          <header>
            <strong>${entry.label}</strong>
            ${observedTime(entry.time)}
          </header>
          <pre>${entry.text}</pre>
        </li>`;
      case "command":
        return html`<li
          class="task-event task-command"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
        >
          <caffold-task-command .event=${entry.event}></caffold-task-command>
        </li>`;
      case "command-group":
        return html`<li
          class="task-event task-command-group"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type="command_execution"
        >
          <caffold-task-command-group
            .identity=${entry.identity}
            .events=${entry.events}
          ></caffold-task-command-group>
        </li>`;
      case "file-change":
        return html`<li
          class="task-event task-file-change"
          data-event-id=${entry.eventId || nothing}
          data-conversation-entry-key=${entry.identity}
          data-event-type=${entry.eventType}
        >
          <article>
            <header>
              <strong>Files changed</strong>
              ${observedTime(entry.time)}
            </header>
            <p>${entry.summary}</p>
            <caffold-task-changed-files
              .files=${entry.files}
            ></caffold-task-changed-files>
          </article>
        </li>`;
      case "turn-work":
        return html`<li
          class="task-event task-turn-work"
          data-turn-id=${entry.turnId}
          data-conversation-entry-key=${entry.identity}
        >
          <caffold-task-work-details
            .identity=${entry.identity}
            .label=${entry.label}
            .updateText=${entry.updateText}
            .events=${entry.events}
            .filePathPresentationBase=${entry.filePathPresentationBase}
          ></caffold-task-work-details>
        </li>`;
      case "approvals":
        return html`<li
          class="task-event task-approval-flow"
          data-conversation-entry-key=${entry.identity}
        >
          <section
            class="task-approvals"
            aria-label="Pending approvals"
          >${repeat(
            entry.requests,
            (request) => request.approvalId ?? "",
            (request) => html`<caffold-task-approval
              data-approval-id=${request.approvalId ?? ""}
              .threadId=${threadId}
              .request=${request}
              .disabled=${controlsDisabled}
              .active=${this.active}
            ></caffold-task-approval>`,
          )}</section>
        </li>`;
      case "active-turn":
        return html`<li
          class="task-event task-turn-active"
          data-active-turn-started-ms=${entry.startedMs ?? nothing}
          data-turn-id=${entry.turnId}
          data-conversation-entry-key=${entry.identity}
        >
          <caffold-task-active-turn
            .startedMs=${entry.startedMs}
            .state=${entry.state}
            .active=${this.active}
          ></caffold-task-active-turn>
        </li>`;
    }
  }

  // Draws the snapshot and keeps the reader's place.
  private draw(previousScroll: ScrollSnapshot | null) {
    this.drawNow();
    const threadId = this.snapshot.threadId;
    if (!this.snapshot.task) {
      this.pendingDisclosureAnchorByThread.delete(threadId);
      this.pendingMarkdownScrollByThread.delete(threadId);
      this.disconnectResizeObserver();
      return;
    }
    const hasPendingMarkdown = this.hasPendingMarkdownRender();
    if (hasPendingMarkdown && previousScroll && !previousScroll.atBottom) {
      this.pendingMarkdownScrollByThread.set(threadId, previousScroll);
    } else if (!hasPendingMarkdown) {
      this.pendingMarkdownScrollByThread.delete(threadId);
    }
    this.restoreScroll(
      this.pendingMarkdownScrollByThread.get(threadId) ?? previousScroll,
    );
    this.restorePendingDisclosureAnchor(this.scroller(), threadId);
    this.bindResizeObserver();
    if (!this.pendingMarkdownScrollByThread.has(threadId)) {
      this.rememberScroll();
    }
  }

  // Lit would draw each component in the microtask after its values change,
  // and a component's children after it. This runs those updates now, the
  // conversation's own first, until none waits.
  private drawNow() {
    this.requestUpdate();
    this.performUpdate();
    for (
      let waiting = this.waitingComponents();
      waiting.length;
      waiting = this.waitingComponents()
    ) {
      for (const component of waiting) {
        (component as unknown as { performUpdate(): void }).performUpdate();
      }
    }
  }

  private waitingComponents() {
    return Array.from(
      this.querySelectorAll<LitElement>(CONVERSATION_COMPONENTS),
    ).filter((component) => component.isUpdatePending);
  }

  private thinkingOpen(entry: ThinkingEntry) {
    return (
      this.disclosureByThread
        .get(this.snapshot.threadId)
        ?.get(entry.disclosureKey) ?? entry.state === "active"
    );
  }

  // The summary toggles the native disclosure; drawing again keeps what the
  // person chose.
  private toggleThinking(event: Event) {
    const summary = event.currentTarget;
    if (!(summary instanceof Element)) {
      return;
    }
    const disclosure = summary.parentElement;
    const threadId = this.snapshot.threadId;
    const key = (disclosure?.dataset.disclosureKey ?? "").trim();
    if (!(disclosure instanceof HTMLDetailsElement) || !key || !threadId) {
      return;
    }
    const open = !disclosure.open;
    this.holdDisclosureAnchor(
      { owner: "conversation", key, open },
      summary.getBoundingClientRect().top,
      summary,
    );
    let state = this.disclosureByThread.get(threadId);
    if (!state) {
      state = new Map();
      this.disclosureByThread.set(threadId, state);
    }
    state.set(key, open);
  }

  private retryDetail(event: Event) {
    event.stopPropagation();
    this.dispatchIntent({ type: "retry-detail" });
  }

  private sendApproval(event: CustomEvent<ApprovalIntentDetail>) {
    const owner = this.approvalComponents().find(
      (card) => card === event.target,
    );
    if (!owner) {
      return;
    }
    event.stopPropagation();
    const { threadId, approvalId, decision } = event.detail;
    if (
      !this.active ||
      isTaskTransportStale(this.snapshot.transportState) ||
      threadId !== this.snapshot.threadId ||
      owner.approvalId !== approvalId
    ) {
      return;
    }
    this.dispatchIntent({ type: "approval", approvalId, decision });
  }

  // A suggested request goes to the Composer only while one could be sent from
  // there, and only from a message this conversation is showing.
  private sendSuggestedPrompt(event: CustomEvent<SuggestedPromptIntentDetail>) {
    const owner = event.target;
    if (
      !(owner instanceof HTMLElement) ||
      !this.conversationList()?.contains(owner)
    ) {
      return;
    }
    event.stopPropagation();
    const { threadId, prompt } = event.detail;
    if (
      !this.active ||
      isTaskTransportStale(this.snapshot.transportState) ||
      threadId !== this.snapshot.threadId ||
      !prompt.trim()
    ) {
      return;
    }
    this.dispatchIntent({ type: "suggested-prompt", prompt });
  }

  private requestOlderHistory(event: CustomEvent<OlderHistoryIntentDetail>) {
    if (
      event.target !== this.olderHistory() ||
      event.detail.threadId !== this.snapshot.threadId ||
      !this.active
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchIntent({ type: "older-history", retry: event.detail.retry });
  }

  private openCommandOutput(event: CustomEvent<CommandIntentDetail>) {
    if (
      !(event.target instanceof CaffoldTaskCommand) ||
      !this.contains(event.target)
    ) {
      return;
    }
    event.stopPropagation();
    if (event.detail.type !== "command-output") {
      return;
    }
    const { commandKey } = event.detail;
    const command = dedupeCanonicalEvents(this.snapshot.events).find(
      (entry) =>
        entry.type === "command_execution" &&
        eventIdentityKey(entry) === commandKey,
    );
    if (command) {
      this.dispatchIntent({ type: "command-output", command });
    }
  }

  private holdCommandAnchor(event: CustomEvent<CommandDisclosureIntentDetail>) {
    const owner = event.target;
    if (!(owner instanceof CaffoldTaskCommand) || !this.contains(owner)) {
      return;
    }
    event.stopPropagation();
    const { commandKey, open } = event.detail;
    if (commandKey) {
      this.holdDisclosureAnchor(
        { owner: "command", commandKey, open },
        owner.disclosureAnchorTop(),
        owner,
      );
    }
  }

  private holdGroupAnchor(
    event: CustomEvent<CommandGroupDisclosureIntentDetail>,
  ) {
    const owner = event.target;
    if (!(owner instanceof CaffoldTaskCommandGroup) || !this.contains(owner)) {
      return;
    }
    event.stopPropagation();
    const { identity, open } = event.detail;
    if (identity) {
      this.holdDisclosureAnchor(
        { owner: "command-group", identity, open },
        owner.disclosureAnchorTop(),
        owner,
      );
    }
  }

  private holdWorkAnchor(
    event: CustomEvent<WorkDetailsDisclosureIntentDetail>,
  ) {
    const owner = event.target;
    if (!(owner instanceof CaffoldTaskWorkDetails) || !this.contains(owner)) {
      return;
    }
    event.stopPropagation();
    const { identity, key, open } = event.detail;
    if (identity && key) {
      this.holdDisclosureAnchor(
        { owner: "work-details", identity, key, open },
        owner.disclosureAnchorTop(key),
        owner,
      );
    }
  }

  private handleMarkdownRendered(event: CustomEvent<MarkdownRenderedDetail>) {
    const scroller = this.scroller();
    if (!scroller) {
      return;
    }
    event.stopPropagation();
    const threadId = this.snapshot.threadId;
    const pendingMarkdownScroll =
      this.pendingMarkdownScrollByThread.get(threadId);
    if (pendingMarkdownScroll) {
      this.restoreScroll(pendingMarkdownScroll);
      if (!this.hasPendingMarkdownRender()) {
        this.pendingMarkdownScrollByThread.delete(threadId);
        this.rememberScroll(threadId);
      }
      return;
    }
    const { before, nextScrollHeight } = event.detail;
    if (before?.atBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
    } else if (
      this.restoreAnchor(scroller, this.scrollByThread.get(threadId) ?? null)
    ) {
      // Preserve the current event while Markdown replaces fallback text.
    } else if (before?.aboveViewport && nextScrollHeight !== null) {
      scroller.scrollTop = Math.min(
        before.scrollTop + (nextScrollHeight - before.scrollHeight),
        maxScrollTop(scroller),
      );
    }
    this.rememberScroll();
  }

  private handleScroll() {
    const scroller = this.scroller();
    this.rememberScroll();
    if (
      !scroller ||
      this.snapshot.loadingOlder ||
      this.snapshot.historyError ||
      !this.snapshot.eventsPage.nextCursor ||
      scroller.scrollTop > 32
    ) {
      return;
    }
    this.dispatchIntent({ type: "older-history" });
  }

  private dispatchIntent(intent: ConversationIntent) {
    this.dispatchEvent(
      new CustomEvent<ConversationIntent>("caffold:task-conversation-intent", {
        bubbles: true,
        composed: true,
        detail: intent,
      }),
    );
  }

  private captureScroll(): ScrollSnapshot | null {
    const scroller = this.scroller();
    if (!scroller || scroller.clientHeight === 0) {
      return null;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const events = [
      ...scroller.querySelectorAll<HTMLElement>(".task-event[data-event-id]"),
    ];
    const anchor =
      events.find((event) => {
        const rect = event.getBoundingClientRect();
        return (
          rect.top >= scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1
        );
      }) ??
      events.find(
        (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
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

  private rememberScroll(threadId = this.snapshot.threadId) {
    const scroll = this.captureScroll();
    if (scroll && threadId) {
      this.scrollByThread.set(threadId, scroll);
    }
    return scroll;
  }

  private restoreScroll(previousScroll: ScrollSnapshot | null) {
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

  private restoreAnchor(
    scroller: HTMLElement,
    previousScroll: ScrollSnapshot | null,
  ) {
    if (
      !previousScroll?.anchorEventId ||
      previousScroll.anchorOffset === null ||
      !Number.isFinite(previousScroll.anchorOffset)
    ) {
      return false;
    }
    const anchor =
      [
        ...scroller.querySelectorAll<HTMLElement>(".task-event[data-event-id]"),
      ].find(
        (event) => event.dataset.eventId === previousScroll.anchorEventId,
      ) ?? this.commandGroupEntryHolding(previousScroll.anchorEventId);
    if (!anchor) {
      return false;
    }
    const currentOffset =
      anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.min(
      Math.max(
        0,
        scroller.scrollTop + currentOffset - previousScroll.anchorOffset,
      ),
      maxScrollTop(scroller),
    );
    return true;
  }

  // The entry a reader was anchored on may have folded into a group since;
  // the group's entry then stands where the reader was looking.
  private commandGroupEntryHolding(eventId: string) {
    return (
      Array.from(this.conversationList()?.children ?? []).find((entry) =>
        entry
          .querySelector<CaffoldTaskCommandGroup>(
            ":scope > caffold-task-command-group",
          )
          ?.holdsEvent(eventId),
      ) ?? null
    );
  }

  private holdDisclosureAnchor(
    target: DisclosureTarget,
    anchorTop: number | null,
    owner: Element,
  ) {
    const scroller = this.scroller();
    const threadId = this.snapshot.threadId;
    if (
      !scroller ||
      !threadId ||
      !scroller.contains(owner) ||
      anchorTop === null ||
      !Number.isFinite(anchorTop)
    ) {
      return;
    }
    this.pendingDisclosureAnchorByThread.set(threadId, {
      ...target,
      offset: anchorTop - scroller.getBoundingClientRect().top,
    });
    window.requestAnimationFrame(() => {
      if (
        this.snapshot.threadId === threadId &&
        this.restorePendingDisclosureAnchor(this.scroller(), threadId)
      ) {
        this.rememberScroll(threadId);
      }
    });
  }

  private restorePendingDisclosureAnchor(
    scroller: HTMLElement | null,
    threadId: string,
  ) {
    const pending = this.pendingDisclosureAnchorByThread.get(threadId);
    if (!scroller || !pending) {
      return false;
    }
    const disclosure = disclosureState(scroller, pending);
    if (!disclosure) {
      this.pendingDisclosureAnchorByThread.delete(threadId);
      return false;
    }
    if (disclosure.open !== pending.open) {
      return false;
    }
    if (disclosure.top === null || !Number.isFinite(disclosure.top)) {
      this.pendingDisclosureAnchorByThread.delete(threadId);
      return false;
    }
    const currentOffset = disclosure.top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.min(
      Math.max(0, scroller.scrollTop + currentOffset - pending.offset),
      maxScrollTop(scroller),
    );
    this.pendingDisclosureAnchorByThread.delete(threadId);
    return true;
  }

  private hasPendingMarkdownRender() {
    return Boolean(
      this.conversationList()?.querySelector(
        'caffold-task-markdown[data-render-state="loading"]',
      ),
    );
  }

  private bindResizeObserver() {
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

  private disconnectResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}

// Whether the disclosure a pending anchor names is open, and where its summary
// stands, or `null` once it is gone.
function disclosureState(scroller: HTMLElement, pending: DisclosureAnchor) {
  if (pending.owner === "work-details") {
    const owner = [
      ...scroller.querySelectorAll<CaffoldTaskWorkDetails>(
        "caffold-task-work-details",
      ),
    ].find((entry) => entry.identity === pending.identity);
    return owner
      ? {
          open: owner.disclosureOpen(pending.key),
          top: owner.disclosureAnchorTop(pending.key),
        }
      : null;
  }
  if (pending.owner === "command") {
    const owner = [
      ...scroller.querySelectorAll<CaffoldTaskCommand>("caffold-task-command"),
    ].find((entry) => entry.commandKey === pending.commandKey);
    return owner
      ? { open: owner.disclosureOpen(), top: owner.disclosureAnchorTop() }
      : null;
  }
  if (pending.owner === "command-group") {
    const owner = [
      ...scroller.querySelectorAll<CaffoldTaskCommandGroup>(
        "caffold-task-command-group",
      ),
    ].find((entry) => entry.identity === pending.identity);
    return owner
      ? { open: owner.disclosureOpen(), top: owner.disclosureAnchorTop() }
      : null;
  }
  const disclosure = [
    ...scroller.querySelectorAll<HTMLDetailsElement>(
      "details[data-disclosure-key]",
    ),
  ].find((entry) => entry.dataset.disclosureKey === pending.key);
  return disclosure
    ? {
        open: disclosure.open,
        top:
          disclosure.querySelector(":scope > summary")?.getBoundingClientRect()
            .top ?? null,
      }
    : null;
}

// The name an entry's keyboard and scroll actions are known by.
function entryIdentity(entry: Element, index: number) {
  return (
    entry.getAttribute("data-conversation-entry-key") ||
    entry.getAttribute("data-event-id") ||
    `${index + 1}`
  );
}

function observedTime(time: string) {
  return time ? html`<time>${time}</time>` : nothing;
}

function rawScrollSurfaceScope({
  scopeId,
  label,
  scrollport,
  clipRoots = [],
  isCurrent = () => true,
}: {
  scopeId: string;
  label: string;
  scrollport: HTMLElement;
  clipRoots?: Element[];
  isCurrent?: () => boolean;
}): ScrollSurfaceScope {
  if (!scopeId || !label || !scrollport) {
    return emptyScrollSurfaceScope();
  }
  return {
    blocked: false,
    surfaces: [
      {
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        axes: ["horizontal"],
        clipRoots: [scrollport, ...clipRoots].filter(Boolean),
        isEligible: () => isCurrent() && hasScrollLayoutBox(scrollport),
      },
    ],
    mutationRoots: [scrollport],
    resizeElements: [scrollport],
    scrollRoots: [scrollport],
  };
}

function isScrolledToBottom(element: HTMLElement) {
  return maxScrollTop(element) - element.scrollTop <= 8;
}

function maxScrollTop(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function sameConversationSnapshot(
  left: ConversationSnapshot,
  right: ConversationSnapshot,
) {
  return (
    left.threadId === right.threadId &&
    left.task === right.task &&
    left.events.length === right.events.length &&
    left.events.every((event, index) => event === right.events[index]) &&
    left.eventsPage.nextCursor === right.eventsPage.nextCursor &&
    left.loadingOlder === right.loadingOlder &&
    left.detailError === right.detailError &&
    left.historyError === right.historyError &&
    left.transportState === right.transportState
  );
}

customElements.define("caffold-task-conversation", CaffoldTaskConversation);
