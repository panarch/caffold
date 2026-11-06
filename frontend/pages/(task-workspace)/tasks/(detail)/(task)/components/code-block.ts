import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { mergeActionHintScopes } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/mermaid-view.js";
import type { CaffoldMermaidView } from "#components/mermaid-view.js";
import type { MarkdownPreviewRequest } from "./markdown-preview-dialog.js";

import styles from "./code-block.css.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;
const MARKDOWN_FENCE_LABELS = new Set(["markdown", "md"]);
const PREVIEW_LABEL = "Preview Markdown";

type CopyState = "idle" | "copying" | "copied" | "failed";

// A block of code on the Task screen, with its name and the actions on it: a
// fenced block of an agent's Markdown, or what a tool call took and returned
// and a command printed in their dialogs.
@customElement("caffold-task-code-block")
export class CaffoldTaskCodeBlock extends CaffoldElement {
  private textValue = "";
  get text() {
    return this.textValue;
  }
  @property({ attribute: false })
  set text(value: string) {
    if (this.textValue !== value) this.invalidatePendingCopy();
    this.textValue = value;
  }
  private labelValue = "Plain text";
  get label() {
    return this.labelValue;
  }
  @property({ attribute: false })
  set label(value: string) {
    if (this.labelValue.toLowerCase() !== value.toLowerCase())
      this.showCode = false;
    this.labelValue = value;
  }
  @state()
  private accessor copyState: CopyState = "idle";
  @state()
  private accessor wrapped = false;

  @state()
  private accessor showCode = false;

  private readonly mermaid = new DrawnRef<CaffoldMermaidView>(this);
  private get isMermaid() {
    return this.label.toLowerCase() === "mermaid";
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("showCode")) this.dispatchLayout("before");
  }

  override updated(changed: PropertyValues) {
    if (changed.has("showCode")) this.dispatchLayout("after");
  }

  private dispatchLayout(phase: "before" | "after") {
    this.dispatchEvent(
      new CustomEvent(`caffold:mermaid-layout-${phase}`, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  static override styles = styles;

  // Wraps a change to the block's height so the conversation keeps its place.
  private preserveLayout: (mutation: () => void) => void = (mutation) =>
    mutation();
  private savedScrollLeft = 0;
  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly pre = new DrawnRef<HTMLPreElement>(this);
  private readonly previewButton = new DrawnRef<HTMLButtonElement>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.invalidatePendingCopy();
  }

  override render() {
    const copy = copyPresentation(this.copyState);
    const name = copy.feedback || this.label;
    const previewing = this.isMermaid && !this.showCode;
    const toggleLabel = previewing ? "Show Mermaid code" : "Preview Mermaid";
    const wrapLabel = this.wrapped
      ? "Stop wrapping code lines"
      : "Wrap code lines";
    return html`
      <header class="code-block-header">
        <span
          class="code-block-label"
          title=${name}
          data-feedback=${copy.tone}
        >${name}</span>
        <span
          class="code-block-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >${copy.feedback}</span>
        <div class="code-block-actions">
          ${
            MARKDOWN_FENCE_LABELS.has(this.label.toLowerCase())
              ? html`<button
                  ${drawn(this.previewButton)}
                  ${this.hints.button({
                    id: "preview",
                    label: PREVIEW_LABEL,
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                  })}
                  type="button"
                  data-code-action="preview"
                  aria-label=${PREVIEW_LABEL}
                  title=${PREVIEW_LABEL}
                  @click=${this.requestPreview}
                >${actionIcon("Eye")}</button>`
              : nothing
          }
          ${
            this.isMermaid
              ? html`<button
            ${this.hints.button({ id: "mermaid-preview", label: toggleLabel, action: ACTION_HINT_ACTION.BUTTON_ACTIVATE })}
            type="button" data-code-action="mermaid-preview" aria-label=${toggleLabel}
            title=${toggleLabel} aria-pressed=${previewing} @click=${this.toggleMermaid}
          >${actionIcon(previewing ? "Code" : "Eye")}</button>`
              : nothing
          }
          <button ?hidden=${previewing}
            ${this.hints.button({
              id: "wrap",
              label: wrapLabel,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
            type="button"
            data-code-action="wrap"
            aria-label=${wrapLabel}
            title=${wrapLabel}
            aria-pressed=${this.wrapped}
            @click=${this.toggleWrap}
          >${actionIcon("WrapText")}</button>
          <button
            ${this.hints.button({
              id: "copy",
              label: copy.actionLabel,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              when: this.copyState !== "copying",
            })}
            type="button"
            data-code-action="copy"
            aria-label=${copy.actionLabel}
            title=${copy.actionLabel}
            aria-disabled=${this.copyState === "copying"}
            data-copy-state=${this.copyState}
            @click=${this.copyCode}
          >${actionIcon(copyIcon(this.copyState))}</button>
        </div>
      </header>
      ${
        this.isMermaid
          ? html`<caffold-mermaid-view
        ${drawn(this.mermaid)} .source=${this.text} .active=${previewing} ?hidden=${!previewing}
      ></caffold-mermaid-view>`
          : nothing
      }
      <div ?hidden=${previewing}
        ${this.surfaces.surface({
          id: "scroll",
          axes: ["horizontal"],
          scrollport: () => this.pre.value,
          clipRoots: () => [this, this.pre.value],
        })}
        class="code-block-content"
      ><pre ${drawn(this.pre)}><code>${this.text}</code></pre></div>
    `;
  }

  // Markdown awaits the reactive update before reporting its new height.
  setContent(
    text: string,
    {
      label,
      preserveLayout,
    }: { label: string; preserveLayout: (mutation: () => void) => void },
  ) {
    this.text = text;
    this.label = label;
    this.preserveLayout = preserveLayout;
  }

  override firstUpdated() {
    this.dataset.codeWrap = "off";
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.mermaid.value?.actionHintScope(pull),
    );
  }

  scrollSurfaceScope({
    label = "Code block",
    ...pull
  }: ScrollSurfacePull = {}) {
    return mergeScrollSurfaceScopes(
      this.surfaces.scope({ ...pull, label }),
      this.mermaid.value?.scrollSurfaceScope({
        ...pull,
        label: "Mermaid diagram",
      }),
    );
  }

  private toggleMermaid() {
    this.showCode = !this.showCode;
  }

  private requestPreview() {
    const opener = this.previewButton.value;
    if (!opener) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<MarkdownPreviewRequest>(
        "caffold:task-markdown-preview-intent",
        {
          bubbles: true,
          composed: true,
          detail: { markdown: this.text, opener },
        },
      ),
    );
  }

  // The wrapped lines change the block's height at once, inside the
  // conversation's keeping of its place; the button follows when it draws.
  private toggleWrap() {
    const pre = this.pre.value;
    if (!pre) {
      return;
    }
    const wrapped = this.wrapped;
    this.preserveLayout(() => {
      if (wrapped) {
        this.dataset.codeWrap = "off";
        pre.scrollLeft = this.savedScrollLeft;
      } else {
        this.savedScrollLeft = pre.scrollLeft;
        this.dataset.codeWrap = "on";
      }
    });
    this.wrapped = !wrapped;
  }

  private async copyCode() {
    const text = this.text;
    if (this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    try {
      await navigator.clipboard.writeText(text);
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.copyState = "copied";
    } catch {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.copyState = "failed";
    }
    this.feedbackTimer = window.setTimeout(() => {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.feedbackTimer = undefined;
      this.copyState = "idle";
    }, COPY_FEEDBACK_DURATION_MS);
  }

  private acceptsCompletion(generation: number) {
    return this.generation === generation && this.isConnected;
  }

  private invalidatePendingCopy() {
    this.generation += 1;
    this.clearFeedback();
    this.copyState = "idle";
  }

  private clearFeedback() {
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
  }
}

function actionIcon(name: string) {
  return html`<span class="code-block-action-icon">${inlineIcon(
    name,
    "",
    "code-block-action-icon-svg",
  )}</span>`;
}

function copyPresentation(state: CopyState) {
  if (state === "copying") {
    return { actionLabel: "Copying code", feedback: "", tone: "" };
  }
  if (state === "copied") {
    return { actionLabel: "Copied", feedback: "Copied", tone: "success" };
  }
  if (state === "failed") {
    return {
      actionLabel: "Copy failed. Retry copy code",
      feedback: "Copy failed — retry",
      tone: "danger",
    };
  }
  return { actionLabel: "Copy code", feedback: "", tone: "" };
}

function copyIcon(state: CopyState) {
  if (state === "copied") {
    return "Check";
  }
  if (state === "failed") {
    return "TriangleAlert";
  }
  return "Copy";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-code-block": CaffoldTaskCodeBlock;
  }

  interface HTMLElementEventMap {
    "caffold:task-markdown-preview-intent": CustomEvent<MarkdownPreviewRequest>;
  }
}
