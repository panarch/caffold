import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";

const COPY_FEEDBACK_DURATION_MS = 1_800;
const MARKDOWN_FENCE_LABELS = new Set(["markdown", "md"]);
const PREVIEW_LABEL = "Preview Markdown";

type CopyState = "idle" | "copying" | "copied" | "failed";
type CodeAction = "preview" | "wrap" | "copy";

// A fenced code block of an agent's Markdown, with its name and the actions on
// it. The Markdown places the block where the `<pre>` it parsed stood and hands
// that `<pre>` over; the block keeps it in a slot its template does not draw.
export class CaffoldTaskMarkdownCodeBlock extends LitElement {
  static properties = {
    label: { attribute: false },
    copyState: { state: true },
    wrapped: { state: true },
  };

  declare label: string;
  declare private copyState: CopyState;
  declare private wrapped: boolean;
  private pre: HTMLPreElement | null = null;
  // Wraps a change to the block's height so the conversation keeps its place.
  private preserveLayout: (mutation: () => void) => void = (mutation) =>
    mutation();
  private savedScrollLeft = 0;
  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.label = "Plain text";
    this.copyState = "idle";
    this.wrapped = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.invalidatePendingCopy();
  }

  render() {
    const copy = copyPresentation(this.copyState);
    const name = copy.feedback || this.label;
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
                  type="button"
                  data-code-action="preview"
                  aria-label=${PREVIEW_LABEL}
                  title=${PREVIEW_LABEL}
                  @click=${this.requestPreview}
                >${actionIcon("Eye")}</button>`
              : nothing
          }
          <button
            type="button"
            data-code-action="wrap"
            aria-label=${wrapLabel}
            title=${wrapLabel}
            aria-pressed=${this.wrapped}
            @click=${this.toggleWrap}
          >${actionIcon("WrapText")}</button>
          <button
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
      <div class="code-block-content"></div>
    `;
  }

  // The Markdown reports its height as soon as it has placed its blocks, so a
  // block draws as it is handed its `<pre>`.
  setContent(
    pre: HTMLPreElement,
    {
      label,
      preserveLayout,
    }: { label: string; preserveLayout: (mutation: () => void) => void },
  ) {
    this.pre = pre;
    this.label = label;
    this.preserveLayout = preserveLayout;
    this.performUpdate();
  }

  firstUpdated() {
    this.dataset.codeWrap = "off";
    if (this.pre) {
      this.querySelector(":scope > .code-block-content")?.append(this.pre);
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    if (!scopeId || !this.isConnected || this.hidden) {
      return emptyActionHintScope();
    }
    const fallbackLabels: Record<CodeAction, string> = {
      preview: PREVIEW_LABEL,
      wrap: "Wrap code lines",
      copy: "Copy code",
    };
    const actions: CodeAction[] = ["preview", "wrap", "copy"];
    const targets = actions.flatMap((action) => {
      const selector = `button[data-code-action="${action}"]`;
      const control = this.querySelector<HTMLButtonElement>(selector);
      if (
        !control ||
        control.disabled ||
        control.getAttribute("aria-disabled") === "true"
      ) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${action}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") ||
            control.title ||
            fallbackLabels[action],
          control,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(selector) === control &&
            !control.disabled &&
            control.getAttribute("aria-disabled") !== "true",
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Code block",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.pre;
    if (
      !scopeId ||
      !label ||
      !scrollport ||
      !this.contains(scrollport) ||
      this.hidden
    ) {
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
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.contains(scrollport) &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private requestPreview() {
    const code = this.code;
    const opener = this.querySelector<HTMLButtonElement>(
      'button[data-code-action="preview"]',
    );
    if (!code || !opener) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-markdown-preview-intent", {
        bubbles: true,
        composed: true,
        detail: { markdown: code.textContent ?? "", opener },
      }),
    );
  }

  // The wrapped lines change the block's height at once, inside the
  // conversation's keeping of its place; the button follows when it draws.
  private toggleWrap() {
    const pre = this.pre;
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
    const code = this.code;
    if (!code || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
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

  private get code() {
    return this.pre?.querySelector(":scope > code") ?? null;
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

customElements.define(
  "caffold-task-markdown-code-block",
  CaffoldTaskMarkdownCodeBlock,
);
