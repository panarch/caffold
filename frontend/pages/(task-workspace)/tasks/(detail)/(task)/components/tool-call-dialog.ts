import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { mergeScrollSurfaceScopes, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { dedupeCanonicalEvents, eventIdentityKey } from "#tasks/task-events.js";
import {
  formatDate,
  formatDuration,
  formatStatus,
  taskEventObservedMs,
} from "#tasks/task-format.js";
import "./code-block.js";
import type { CaffoldTaskCodeBlock } from "./code-block.js";

import styles from "./tool-call-dialog.css.js";

/**
 * A tool call a Task's agent made, with what it was given and what came back,
 * over the Task screen. The dialog follows the same call while it is open, so
 * a result that arrives while it is being read appears in place. It belongs to
 * one Task and closes when another Task opens.
 */
@customElement("caffold-task-tool-call-dialog")
export class CaffoldTaskToolCallDialog extends CaffoldElement {
  @state()
  private accessor threadId = "";
  @state()
  private accessor toolCall: TaskEvent | null = null;
  // Counts the times a call was opened, so each opening, of the same call
  // too, draws fresh code blocks while following the open call keeps them.
  @state()
  private accessor openings = 0;

  static override styles = styles;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly codeBlocks = new DrawnRefs<CaffoldTaskCodeBlock>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setThreadId(threadId: string) {
    if (this.threadId && this.threadId !== threadId) {
      this.dismiss();
    }
    this.threadId = threadId;
  }

  openToolCall(event: TaskEvent) {
    this.toolCall = event;
    this.openings += 1;
    this.performUpdate();
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    // A new call starts at its top and its first column.
    const body = this.body.value;
    for (const scrollport of body
      ? [body, ...body.querySelectorAll("pre")]
      : []) {
      scrollport.scrollTop = 0;
      scrollport.scrollLeft = 0;
    }
  }

  // The newest report of the open call, from the events the conversation was
  // just given. A call no longer among them keeps what was last shown.
  follow(events: TaskEvent[]) {
    const open = this.toolCall;
    if (!open || !this.dialog.value?.open) {
      return;
    }
    const key = eventIdentityKey(open);
    const next = dedupeCanonicalEvents(events).find(
      (event) => event.type === "tool_call" && eventIdentityKey(event) === key,
    );
    if (next && next !== open) {
      this.toolCall = next;
    }
  }

  dismiss() {
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) =>
        mergeActionHintScopes(
          this.hints.scope(pull),
          ...this.shownCodeBlocks().map(({ key, block }) =>
            block.actionHintScope({
              ...pull,
              scopeId: `${pull.scopeId}:${key}`,
            }),
          ),
        ),
      scroll: (pull) =>
        mergeScrollSurfaceScopes(
          this.surfaces.scope(pull),
          ...this.shownCodeBlocks().map(({ key, label, block }) =>
            block.scrollSurfaceScope({
              ...pull,
              scopeId: `${pull.scopeId}:${key}`,
              label,
              clipRoots: [
                ...(this.body.value ? [this.body.value] : []),
                ...(pull.clipRoots ?? []),
              ],
            }),
          ),
        ),
    });
  }

  override render() {
    const payload = this.toolCall?.payload ?? {};
    const status = `${payload.status ?? ""}`.trim();
    const statusLabel = STATUS_LABELS[status] ?? formatStatus(status);
    const server = `${payload.server ?? ""}`.trim();
    const durationMs = payload.durationMs;
    const observedMs = taskEventObservedMs(this.toolCall);
    const result = payload.result ?? [];
    const closeLabel = "Close tool call details";
    const clipRoots = () => [this.body.value];
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: this.threadId
          ? `task-tool-call:${encodeURIComponent(this.threadId)}`
          : "task-tool-call",
      })}
      aria-labelledby="task-tool-call-dialog-title"
      data-tool-call-status=${this.toolCall ? status : nothing}
      @click=${this.closeFromBackdrop}
    >
      <article class="task-tool-call-dialog-card">
        <header class="task-tool-call-dialog-header">
          <div>
            <h2 id="task-tool-call-dialog-title">Tool call details</h2>
            <p data-tool-call-dialog-status>${this.toolCall ? statusLabel : ""}</p>
          </div>
          <button
            ${this.hints.button({
              id: "close",
              label: closeLabel,
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="button"
            class="task-tool-call-dialog-close"
            data-tool-call-dialog-action="close"
            title=${closeLabel}
            aria-label=${closeLabel}
            @click=${this.dismiss}
          >${inlineIcon("X", closeLabel, "task-tool-call-dialog-close-icon")}</button>
        </header>
        <div
          ${drawn(this.body)}
          ${this.surfaces.surface({
            id: "body",
            label: () => "Tool call details",
            clipRoots,
          })}
          class="task-tool-call-dialog-body"
          data-tool-call-dialog-body
        >${
          this.toolCall
            ? html`<dl class="task-tool-call-dialog-details">
                  <div>
                    <dt>Tool</dt>
                    <dd><code>${`${payload.name ?? ""}`.trim() || "Tool call"}</code></dd>
                  </div>
                  ${
                    server
                      ? html`<div>
                        <dt>Server</dt>
                        <dd><code>${server}</code></dd>
                      </div>`
                      : nothing
                  }
                  <div><dt>Status</dt><dd>${statusLabel}</dd></div>
                  ${
                    typeof durationMs === "number" &&
                    Number.isFinite(durationMs)
                      ? html`<div>
                        <dt>Duration</dt>
                        <dd>${formatDuration(durationMs)}</dd>
                      </div>`
                      : nothing
                  }
                  ${
                    observedMs !== null
                      ? html`<div>
                        <dt>Timeline time</dt>
                        <dd><time>${formatDate(observedMs)}</time></dd>
                      </div>`
                      : nothing
                  }
                </dl>
                ${keyed(
                  this.openings,
                  html`<section
                  class="task-tool-call-dialog-section"
                  data-tool-call-dialog-section="input"
                  aria-labelledby="task-tool-call-input-title"
                >
                  <h3 id="task-tool-call-input-title">Input</h3>
                  ${
                    payload.input === undefined || payload.input === null
                      ? html`<pre
                          ${this.surfaces.surface({
                            id: "input",
                            label: () => "Tool call input",
                            axes: ["horizontal"],
                            clipRoots,
                          })}
                        >(No input)</pre>`
                      : html`<caffold-task-code-block
                          ${drawn(this.codeBlocks.of("input"))}
                          .label=${"JSON"}
                          .text=${asJson(payload.input)}
                        ></caffold-task-code-block>`
                  }
                </section>
                <section
                  class="task-tool-call-dialog-section"
                  data-tool-call-dialog-section="result"
                  aria-labelledby="task-tool-call-result-title"
                >
                  <h3 id="task-tool-call-result-title">Result</h3>
                  ${
                    result.length
                      ? result.map((part, index) =>
                          part.type === "binary"
                            ? html`<pre
                                ${this.surfaces.surface({
                                  id: `result:${index}`,
                                  label: () => `Tool call result ${index + 1}`,
                                  axes: ["horizontal"],
                                  clipRoots,
                                })}
                                data-tool-call-result-part="binary"
                              >${
                                part.mediaType
                                  ? `(${part.mediaType} not shown)`
                                  : "(Binary content not shown)"
                              }</pre>`
                            : html`<caffold-task-code-block
                                ${drawn(this.codeBlocks.of(`result:${index}`))}
                                data-tool-call-result-part=${part.type}
                                .label=${part.type === "json" ? "JSON" : "Plain text"}
                                .text=${
                                  part.type === "json"
                                    ? asJson(part.value)
                                    : part.text
                                }
                              ></caffold-task-code-block>`,
                        )
                      : html`<pre data-tool-call-result-part="none">${
                          status === "inProgress"
                            ? "(No result yet)"
                            : "(No result)"
                        }</pre>`
                  }
                </section>`,
                )}`
            : nothing
        }</div>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  // The code blocks the open call shows, each with the name its scroll
  // surface goes by.
  private shownCodeBlocks() {
    const result = this.toolCall?.payload?.result ?? [];
    return [
      { key: "input", label: "Tool call input" },
      ...result.map((_, index) => ({
        key: `result:${index}`,
        label: `Tool call result ${index + 1}`,
      })),
    ].flatMap(({ key, label }) => {
      const block = this.codeBlocks.get(key);
      return block?.isConnected ? [{ key, label, block }] : [];
    });
  }

  private closeFromBackdrop(event: Event) {
    if (event.target === this.dialog.value) {
      this.dismiss();
    }
  }
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  declined: "Declined",
  inProgress: "In progress",
};

function asJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? `${value}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-tool-call-dialog": CaffoldTaskToolCallDialog;
  }
}
