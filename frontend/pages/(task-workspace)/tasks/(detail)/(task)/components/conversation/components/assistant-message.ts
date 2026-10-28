import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  type ActionHintPull,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import type { ScrollSurfacePull } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import {
  type AssistantMessagePhase,
  assistantMessagePhase,
} from "#tasks/task-events.js";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.js";
import "./assistant-message/components/copy-button.js";
import type { CaffoldTaskAssistantMessageCopyButton } from "./assistant-message/components/copy-button.js";
import "./assistant-message/components/suggested-prompts.js";
import type { CaffoldTaskAssistantMessageSuggestedPrompts } from "./assistant-message/components/suggested-prompts.js";
import "./markdown.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldTaskMarkdown } from "./markdown.js";

import styles from "./assistant-message.css.js";

export type { SuggestedPromptIntentDetail } from "./assistant-message/components/suggested-prompts.js";

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
@customElement("caffold-task-assistant-message")
export class CaffoldTaskAssistantMessage extends CaffoldElement {
  @property({ attribute: false })
  accessor event: TaskEvent | null = null;
  @property({ attribute: false })
  accessor phase: AssistantMessagePhase | null = null;
  @property({ attribute: false })
  accessor turnCompletedMs: number | null = null;
  @property({ attribute: false })
  accessor controlsDisabled = false;

  static override styles = styles;

  private readonly copyButton =
    new DrawnRef<CaffoldTaskAssistantMessageCopyButton>(this);
  private readonly markdown = new DrawnRef<CaffoldTaskMarkdown>(this);
  private readonly suggestedPrompts =
    new DrawnRef<CaffoldTaskAssistantMessageSuggestedPrompts>(this);

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

  override render() {
    const { text, time, threadId, fileLinks, phase, suggestedPrompts } =
      this.presentation;
    return html`
      <div class="task-assistant-message-header">
        <time>${time}</time>
        <caffold-task-assistant-message-copy-button
          ${drawn(this.copyButton)}
          ?hidden=${!text.trim()}
          .text=${text}
        ></caffold-task-assistant-message-copy-button>
      </div>
      <div class="task-assistant-message-body">
        <caffold-task-markdown
          ${drawn(this.markdown)}
          thread-id=${threadId || nothing}
          ?code-block-controls=${phase === "final"}
          .fileLinks=${fileLinks}
          .markdown=${text}
        ></caffold-task-markdown>
      </div>
      <caffold-task-assistant-message-suggested-prompts
        ${drawn(this.suggestedPrompts)}
        .threadId=${threadId}
        .prompts=${suggestedPrompts}
        .disabled=${this.controlsDisabled}
      ></caffold-task-assistant-message-suggested-prompts>
    `;
  }

  override updated() {
    const { phase } = this.presentation;
    if ((this.dataset.messagePhase ?? "") !== phase) {
      if (phase) {
        this.dataset.messagePhase = phase;
      } else {
        delete this.dataset.messagePhase;
      }
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
    const childClipRoots = [this, ...clipRoots];
    return mergeActionHintScopes(
      this.copyButton.value?.actionHintScope({
        scopeId: `${scopeId}:copy-button`,
        clipRoots: childClipRoots,
      }),
      this.markdown.value?.actionHintScope({
        scopeId: `${scopeId}:markdown`,
        clipRoots: childClipRoots,
      }),
      this.suggestedPrompts.value?.actionHintScope({
        scopeId: `${scopeId}:suggested-prompts`,
        clipRoots: childClipRoots,
      }),
    );
  }

  scrollSurfaceScope({ scopeId = "", clipRoots = [] }: ScrollSurfacePull = {}) {
    return this.markdown.value?.scrollSurfaceScope({
      scopeId: `${scopeId}:markdown`,
      clipRoots: [this, ...clipRoots],
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-assistant-message": CaffoldTaskAssistantMessage;
  }
}
