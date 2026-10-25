import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import type { TaskEvent } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import {
  type AssistantMessagePhase,
  assistantMessagePhase,
} from "#tasks/task-events.js";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.js";
import "./assistant-message/components/copy-button.ts";
import type { CaffoldTaskAssistantMessageCopyButton } from "./assistant-message/components/copy-button.ts";
import "./assistant-message/components/suggested-prompts.ts";
import type { CaffoldTaskAssistantMessageSuggestedPrompts } from "./assistant-message/components/suggested-prompts.ts";
import "./markdown.ts";
import type { CaffoldTaskMarkdown } from "./markdown.ts";

export type { SuggestedPromptIntentDetail } from "./assistant-message/components/suggested-prompts.ts";

/**
 * What the agent said, drawn the same way wherever the conversation shows it.
 *
 * A turn in progress lists its messages inline and a finished turn folds them
 * into its work details, but that is a difference in where the message is
 * placed. Owning the card here is what keeps the message from changing shape
 * when its turn ends, and what gives every message the same Copy control
 * beside its time.
 *
 * `phase` is the placing surface's, not the event's: which message answers a
 * turn is decided by the surface placing it, and Claude does not mark one
 * itself.
 */
export class CaffoldTaskAssistantMessage extends LitElement {
  static properties = {
    event: { attribute: false },
    phase: { attribute: false },
    turnCompletedMs: { attribute: false },
    controlsDisabled: { attribute: false },
  };

  declare event: TaskEvent | null;
  declare phase: AssistantMessagePhase | null;
  declare turnCompletedMs: number | null;
  declare controlsDisabled: boolean;

  constructor() {
    super();
    this.event = null;
    this.phase = null;
    this.turnCompletedMs = null;
    this.controlsDisabled = false;
  }

  createRenderRoot() {
    return this;
  }

  get presentation() {
    const { event } = this;
    const payload = event?.payload ?? {};
    const observedMs = taskEventObservedMs(event);
    const timeMs =
      observedMs ??
      (Number.isFinite(this.turnCompletedMs) ? this.turnCompletedMs : null);
    return {
      text: `${payload.text ?? ""}`,
      time: timeMs === null ? "" : formatDate(timeMs),
      threadId: event?.threadId ?? "",
      fileLinks: event?.fileLinks ?? [],
      phase: assistantMessagePhase(this.phase ?? payload.phase) ?? "",
      suggestedPrompts: Array.isArray(payload.suggestedPrompts)
        ? payload.suggestedPrompts
        : [],
    };
  }

  render() {
    const { text, time, threadId, fileLinks, phase, suggestedPrompts } =
      this.presentation;
    return html`
      <div class="task-assistant-message-header">
        <time>${time}</time>
        <caffold-task-assistant-message-copy-button
          ?hidden=${!text.trim()}
          .text=${text}
        ></caffold-task-assistant-message-copy-button>
      </div>
      <div class="task-assistant-message-body">
        <caffold-task-markdown
          thread-id=${threadId || nothing}
          ?code-block-controls=${phase === "final"}
          .fileLinks=${fileLinks}
          .markdown=${text}
        ></caffold-task-markdown>
      </div>
      <caffold-task-assistant-message-suggested-prompts
        .threadId=${threadId}
        .prompts=${suggestedPrompts}
        .disabled=${this.controlsDisabled}
      ></caffold-task-assistant-message-suggested-prompts>
    `;
  }

  updated() {
    const { phase } = this.presentation;
    if ((this.dataset.messagePhase ?? "") !== phase) {
      if (phase) {
        this.dataset.messagePhase = phase;
      } else {
        delete this.dataset.messagePhase;
      }
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const childClipRoots = [this, ...clipRoots].filter(Boolean);
    return mergeActionHintScopes(
      this.copyButton?.actionHintScope({
        scopeId: `${scopeId}:copy-button`,
        clipRoots: childClipRoots,
      }),
      this.markdown?.actionHintScope({
        scopeId: `${scopeId}:markdown`,
        clipRoots: childClipRoots,
      }),
      this.suggestedPrompts?.actionHintScope({
        scopeId: `${scopeId}:suggested-prompts`,
        clipRoots: childClipRoots,
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const markdown = this.markdown;
    return scopeId && markdown && !this.hidden
      ? markdown.scrollSurfaceScope({
          scopeId: `${scopeId}:markdown`,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isCurrent: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.markdown === markdown,
        })
      : emptyScrollSurfaceScope();
  }

  private get copyButton() {
    return this.querySelector<CaffoldTaskAssistantMessageCopyButton>(
      ":scope > .task-assistant-message-header > caffold-task-assistant-message-copy-button",
    );
  }

  private get markdown() {
    return this.querySelector<CaffoldTaskMarkdown>(
      ":scope > .task-assistant-message-body > caffold-task-markdown",
    );
  }

  private get suggestedPrompts() {
    return this.querySelector<CaffoldTaskAssistantMessageSuggestedPrompts>(
      ":scope > caffold-task-assistant-message-suggested-prompts",
    );
  }
}

customElements.define(
  "caffold-task-assistant-message",
  CaffoldTaskAssistantMessage,
);
