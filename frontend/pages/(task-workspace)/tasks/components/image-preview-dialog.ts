import { html, LitElement, nothing } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { fetchInChunks } from "#app/chunked-fetch.ts";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";

export const TASK_IMAGE_PREVIEW_EVENT = "caffold:task-image-preview";

// A picture to see larger: where it is, and the name it shows under.
export interface TaskImagePreviewRequest {
  src: string;
  name: string;
}

export function requestTaskImagePreview(
  target: Element,
  image: Partial<TaskImagePreviewRequest> = {},
) {
  const src = `${image.src ?? ""}`.trim();
  if (!src) {
    return false;
  }
  target.dispatchEvent(
    new CustomEvent<TaskImagePreviewRequest>(TASK_IMAGE_PREVIEW_EVENT, {
      bubbles: true,
      composed: true,
      detail: {
        src,
        name: `${image.name ?? ""}`.trim(),
      },
    }),
  );
  return true;
}

// What the preview shows: the picture, that it is still loading, or that it
// cannot be shown.
type PictureView = "image" | "loading" | "unavailable";

/**
 * One picture from a Task, larger, in a dialog over the Tasks screen.
 *
 * The Tasks screen opens it and shows it at once, so it draws in place.
 */
export class CaffoldTaskImagePreviewDialog extends LitElement {
  private name = "";
  private src = "";
  private view: PictureView = "image";
  private picture: { fetching: AbortController; objectUrl: string } | null =
    null;
  private readonly iconsReady = () => this.requestUpdate();

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
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    const dialog = this.dialog;
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    if (!dialog || !hintDialog) {
      return [];
    }
    return [
      keyboardNavigationContext({
        id: "task-image-preview",
        kind: "modal",
        root: dialog,
        actionHints: {
          dialog: hintDialog,
          scope: this.actionHintScope(),
        },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const control = dialog?.querySelector<HTMLButtonElement>(
      ".task-image-preview-close",
    );
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: "task-image-preview:close",
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.getAttribute("aria-label") || "Close image preview",
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            dialog.querySelector(".task-image-preview-close") === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  openImage(image: Partial<TaskImagePreviewRequest> = {}) {
    const src = `${image.src ?? ""}`.trim();
    if (!src) {
      return false;
    }
    this.name = `${image.name ?? ""}`.trim() || "Attached image";
    this.releasePicture();
    const inline = src.startsWith("data:");
    // Until the picture is drawn, the preview says it is loading rather than
    // showing an empty image the browser would draw as broken.
    this.src = inline ? src : "";
    this.view = inline ? "image" : "loading";
    this.draw();
    if (!inline) {
      this.showFetchedPicture(src);
    }
    const dialog = this.dialog;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  dismiss() {
    const dialog = this.dialog;
    if (dialog?.open) {
      dialog.close();
    }
  }

  render() {
    return html`
      <dialog
        closedby="any"
        aria-labelledby="task-image-preview-title"
        @close=${this.reset}
      >
        <article class="task-image-preview-card">
          <header class="task-image-preview-header">
            <div>
              <h2 id="task-image-preview-title">Image preview</h2>
              <p data-task-image-preview-name>${this.name}</p>
            </div>
            <form method="dialog">
              <button
                type="submit"
                class="task-image-preview-close"
                aria-label="Close image preview"
                title="Close image preview"
                autofocus
              >${inlineIcon(
                "X",
                "Close image preview",
                "task-image-preview-close-icon",
              )}</button>
            </form>
          </header>
          <div class="task-image-preview-body">
            <div class="task-image-preview-viewport">
              <img
                data-task-image-preview-image
                alt=${this.name}
                src=${this.src || nothing}
                ?hidden=${this.view !== "image"}
                @load=${this.showLoaded}
                @error=${this.showUnavailable}
              >
              <caffold-loading-text
                data-task-image-preview-loading
                ?hidden=${this.view !== "loading"}
              >Loading image...</caffold-loading-text>
              <p
                class="task-image-preview-unavailable"
                data-task-image-preview-unavailable
                ?hidden=${this.view !== "unavailable"}
              >Image preview unavailable.</p>
            </div>
          </div>
        </article>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  // A picture the server holds is fetched in cells; the list that opened the
  // preview has usually fetched it already.
  private showFetchedPicture(src: string) {
    const fetching = new AbortController();
    const picture = { fetching, objectUrl: "" };
    this.picture = picture;
    fetchInChunks(src, { signal: fetching.signal }).then(
      ({ file }) => {
        if (this.picture !== picture) {
          return;
        }
        picture.objectUrl = URL.createObjectURL(file);
        this.src = picture.objectUrl;
        this.draw();
      },
      (error) => {
        if (
          this.picture === picture &&
          (error as Error | null)?.name !== "AbortError"
        ) {
          this.showUnavailable();
        }
      },
    );
  }

  private releasePicture() {
    const picture = this.picture;
    if (!picture) {
      return;
    }
    this.picture = null;
    picture.fetching.abort();
    if (picture.objectUrl) {
      URL.revokeObjectURL(picture.objectUrl);
    }
  }

  private showLoaded() {
    this.view = "image";
    this.draw();
  }

  private showUnavailable() {
    this.view = "unavailable";
    this.draw();
  }

  private reset() {
    this.releasePicture();
    this.name = "";
    this.src = "";
    this.view = "image";
    this.draw();
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }
}

customElements.define(
  "caffold-task-image-preview-dialog",
  CaffoldTaskImagePreviewDialog,
);
