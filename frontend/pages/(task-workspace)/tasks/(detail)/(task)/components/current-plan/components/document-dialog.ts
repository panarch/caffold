import { html, LitElement, nothing } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { readFile } from "#app/api.ts";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "#components/markdown-preview.ts";
import type { CaffoldMarkdownPreview } from "#components/markdown-preview.ts";
import type { CurrentPlanDocument } from "../model.ts";

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

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.performUpdate();
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
    const dialog = this.dialog;
    if (!dialog.open) {
      dialog.showModal();
    }
    void this.loadCurrent();
    return true;
  }

  refreshOpenDocument() {
    if (!this.dialog?.open || !this.current) {
      return;
    }
    void this.loadCurrent({ preserveScroll: true });
  }

  deactivate() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.preview?.releaseImages();
    this.opener = null;
    this.current = null;
    if (this.dialog?.open) {
      this.dialog.close("deactivate");
    }
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const path = this.current?.path ?? "";
    if (!dialog) {
      return emptyActionHintScope();
    }
    const controls = [
      ["close", ".current-plan-document-close"],
      ["retry", '[data-current-plan-dialog-action="retry"]'],
    ];
    const isCurrent = () =>
      this.isConnected &&
      this.dialog === dialog &&
      dialog.open &&
      this.current?.path === path &&
      Boolean(path);
    const preview = this.preview;
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: controls.flatMap(([identity, selector]) => {
          const control = dialog.querySelector<HTMLButtonElement>(selector);
          if (!control) {
            return [];
          }
          return [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: `current-plan-document:${encodeURIComponent(path)}:${identity}`,
              actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
              label:
                control.getAttribute("aria-label") ||
                control.textContent?.trim() ||
                identity,
              control,
              clipRoots: [dialog],
              isActionable: () =>
                isCurrent() &&
                dialog.querySelector(selector) === control &&
                hasActionHintLayoutBox(control) &&
                !control.disabled,
            }),
          ];
        }),
        mutationRoots: [this],
        scrollRoots: [],
      },
      preview?.actionHintScope({
        scopeId: `current-plan-document:${encodeURIComponent(path)}:preview`,
        linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
        clipRoots: [dialog],
        isCurrent: () => isCurrent() && this.preview === preview,
      }),
    );
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const preview = this.preview;
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog || !preview || !hintDialog || !hud || !selector) {
      return [];
    }
    const path = this.current?.path ?? "";
    const label = this.current?.label ?? "Document";
    const scope = !path
      ? emptyScrollSurfaceScope()
      : preview.scrollSurfaceScope({
          scopeId: `current-plan:${path}:preview`,
          label: `${label} document`,
          clipRoots: [dialog],
          isCurrent: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            this.current?.path === path &&
            this.preview === preview &&
            !preview.hidden,
        });
    return [
      keyboardNavigationContext({
        id: path ? `current-plan-document:${path}` : "current-plan-document",
        kind: "modal",
        root: dialog,
        actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
        scroll: { hud, selector, scope },
      }),
    ];
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
              type="button"
              data-current-plan-dialog-action="retry"
              @click=${this.retry}
            >Retry</button>
          </div>
          <caffold-markdown-preview
            ?hidden=${!this.previewShown}
          ></caffold-markdown-preview>
        </div>
      </article>
      <caffold-keyboard-navigation-presentation
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
    const scroll = preserveScroll ? this.preview.getScrollState() : null;
    this.show(preserveScroll ? "refreshing" : "loading");
    try {
      const file = await readFile(current.path, controller.signal);
      if (!this.acceptRequest(requestId, current.path)) {
        return;
      }
      this.requestController = null;
      this.show("shown");
      this.preview.setMarkdown(file.content, {
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
      Boolean(this.dialog?.open)
    );
  }

  private retry() {
    void this.loadCurrent({ preserveScroll: true });
  }

  private handleClose() {
    if (this.dialog.open) {
      return;
    }
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.preview?.releaseImages();
    const opener = this.opener;
    this.opener = null;
    this.current = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }

  private get dialog() {
    return this.querySelector(":scope > dialog") as HTMLDialogElement;
  }

  private get preview() {
    return this.querySelector(
      ":scope > dialog caffold-markdown-preview",
    ) as CaffoldMarkdownPreview;
  }
}

customElements.define(
  "caffold-current-plan-document-dialog",
  CaffoldCurrentPlanDocumentDialog,
);
