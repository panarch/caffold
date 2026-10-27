import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { readFile } from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "#components/markdown-preview.js";
import type { CaffoldMarkdownPreview } from "#components/markdown-preview.js";
import type { CurrentPlanDocument } from "../model.js";

// What the Current Plan asks the dialog to show. `rootPath` is the Task root
// that an image address starting with "/" is read from.
export interface PlanDocumentRequest {
  label?: string;
  document?: Partial<CurrentPlanDocument> | null;
  displayPath?: string;
  rootPath?: string;
  opener?: Element | null;
}

interface OpenDocument {
  label: string;
  path: string;
  displayPath: string;
  rootPath: string;
}

// A first read has nothing to show yet, so its phrase takes the document's
// place; a refresh keeps the document shown under its status.
type ReadPhase = "idle" | "loading" | "refreshing" | "failed" | "shown";

/**
 * One of a Task's plan files, read and drawn as Markdown over the Task screen.
 * It reads the file again when the Current Plan reports that it changed.
 */
export class CaffoldCurrentPlanDocumentDialog extends LitElement {
  private requestId = 0;
  private requestController: AbortController | null = null;
  private current: OpenDocument | null = null;
  private opener: HTMLElement | null = null;
  private phase: ReadPhase = "idle";
  private previewShown = false;
  private failure = "";
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly preview = new DrawnRef<CaffoldMarkdownPreview>(this);

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
    this.deactivate();
  }

  openDocument({
    label,
    document,
    displayPath,
    rootPath,
    opener,
  }: PlanDocumentRequest = {}) {
    const path = `${document?.path ?? ""}`.trim();
    if (!path) {
      return false;
    }
    this.current = {
      label: `${label ?? document?.name ?? "Document"}`.trim() || "Document",
      path,
      displayPath: `${displayPath ?? ""}`.trim() || path,
      rootPath: `${rootPath ?? ""}`.trim(),
    };
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.show("loading");
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    void this.loadCurrent();
    return true;
  }

  refreshOpenDocument() {
    if (!this.dialog.value?.open || !this.current) {
      return;
    }
    void this.loadCurrent({ preserveScroll: true });
  }

  deactivate() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.preview.value?.releaseImages();
    this.opener = null;
    this.current = null;
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close("deactivate");
    }
  }

  keyboardNavigationContexts() {
    const label = this.current?.label ?? "Document";
    return this.keyboard.contexts({
      actionHints: (pull) =>
        mergeActionHintScopes(
          this.hints.scope(pull),
          this.preview.value?.actionHintScope({
            ...pull,
            scopeId: `${pull.scopeId}:preview`,
            actions: { link: ACTION_HINT_ACTION.LINK_OPEN },
          }),
        ),
      scroll: (pull) =>
        this.preview.value?.scrollSurfaceScope({
          ...pull,
          scopeId: `${pull.scopeId}:preview`,
          label: `${label} document`,
        }) ?? emptyScrollSurfaceScope(),
    });
  }

  render() {
    const current = this.current;
    const phase = this.phase;
    const closeIcon = inlineIcon(
      "X",
      "Close document",
      "current-plan-document-close-icon",
    );
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: current
          ? `current-plan-document:${current.path}`
          : "current-plan-document",
      })}
      closedby="any"
      aria-labelledby="current-plan-document-title"
      @close=${this.handleClose}
    >
      <article class="current-plan-document-card">
        <header>
          <div>
            <h2 id="current-plan-document-title" data-current-plan-dialog-title
              >${current?.label ?? "Plan"}</h2
            >
            <p data-current-plan-dialog-path title=${current?.path ?? nothing}
              >${current?.displayPath ?? ""}</p
            >
          </div>
          <form method="dialog">
            <button
              ${this.hints.button({
                id: "close",
                label: "Close document",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="current-plan-document-close"
              aria-label="Close document"
              title="Close document"
            >${closeIcon}</button>
          </form>
        </header>
        <div class="current-plan-document-body">
          <p
            class="current-plan-document-status"
            role="status"
            data-current-plan-dialog-status
            ?hidden=${phase !== "refreshing"}
          >
            Refreshing document...
          </p>
          <caffold-loading-text
            class="current-plan-document-loading"
            data-current-plan-dialog-loading
            ?hidden=${phase !== "loading"}
          >Loading document...</caffold-loading-text>
          <div
            class="current-plan-document-error"
            role="alert"
            data-current-plan-dialog-error
            ?hidden=${phase !== "failed"}
          >
            <p data-current-plan-dialog-error-message>${this.failure}</p>
            <button
              ${this.hints.button({
                id: "retry",
                label: "Retry",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="button"
              data-current-plan-dialog-action="retry"
              @click=${this.retry}
            >Retry</button>
          </div>
          <caffold-markdown-preview
            ${drawn(this.preview)}
            ?hidden=${!this.previewShown}
          ></caffold-markdown-preview>
        </div>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private async loadCurrent({ preserveScroll = false } = {}) {
    const current = this.current;
    if (!current) {
      return;
    }
    const requestId = ++this.requestId;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    const scroll = preserveScroll
      ? (this.preview.value?.getScrollState() ?? null)
      : null;
    this.show(preserveScroll ? "refreshing" : "loading");
    try {
      const file = await readFile(current.path, controller.signal);
      if (!this.acceptRequest(requestId, current.path)) {
        return;
      }
      this.requestController = null;
      this.show("shown");
      this.preview.value?.setMarkdown(file.content, {
        scroll,
        images: {
          folder: current.path.split("/").slice(0, -1).join("/"),
          root: current.rootPath,
        },
      });
    } catch (error) {
      if (
        !this.acceptRequest(requestId, current.path) ||
        (error as Error | null)?.name === "AbortError"
      ) {
        return;
      }
      this.requestController = null;
      this.failure = (error as Error | null)?.message ?? `${error}`;
      this.show("failed", { keepPreview: preserveScroll });
    }
  }

  // The preview shows once a read succeeds; a first read and its failure
  // hide it, while a refresh and its failure keep whatever it shows.
  private show(
    phase: ReadPhase,
    { keepPreview = phase === "refreshing" } = {},
  ) {
    this.phase = phase;
    if (phase === "shown") {
      this.previewShown = true;
    } else if (!keepPreview) {
      this.previewShown = false;
    }
    this.requestUpdate();
    this.performUpdate();
  }

  private acceptRequest(requestId: number, path: string) {
    return (
      requestId === this.requestId &&
      this.current?.path === path &&
      Boolean(this.dialog.value?.open)
    );
  }

  private retry() {
    void this.loadCurrent({ preserveScroll: true });
  }

  private handleClose() {
    if (this.dialog.value?.open) {
      return;
    }
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.preview.value?.releaseImages();
    const opener = this.opener;
    this.opener = null;
    this.current = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }
}

customElements.define(
  "caffold-current-plan-document-dialog",
  CaffoldCurrentPlanDocumentDialog,
);
