import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { fetchInChunks } from "#app/chunked-fetch.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";

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

/** One picture from a Task, larger, in a dialog over the Tasks screen. */
@customElement("caffold-task-image-preview-dialog")
export class CaffoldTaskImagePreviewDialog extends LitElement {
  @state()
  private accessor name = "";
  @state()
  private accessor src = "";
  @state()
  private accessor view: PictureView = "image";

  private picture: { fetching: AbortController; objectUrl: string } | null =
    null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
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
    if (!inline) {
      this.showFetchedPicture(src);
    }
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  dismiss() {
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  override render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "task-image-preview" })}
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
                ${this.hints.button({
                  id: "close",
                  label: "Close image preview",
                  action: ACTION_HINT_ACTION.DIALOG_BUTTON,
                })}
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
          ${this.keyboard.presentation()}
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
  }

  private showUnavailable() {
    this.view = "unavailable";
  }

  private reset() {
    this.releasePicture();
    this.name = "";
    this.src = "";
    this.view = "image";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-image-preview-dialog": CaffoldTaskImagePreviewDialog;
  }

  interface HTMLElementEventMap {
    [TASK_IMAGE_PREVIEW_EVENT]: CustomEvent<TaskImagePreviewRequest>;
  }
}
