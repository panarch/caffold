import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { inlineIcon } from "#components/icons.js";
import { requestTaskImagePreview } from "../../image-preview-dialog.js";

// A file a draft will send. A picture every agent can be shown also carries
// its contents as a data URL.
export interface ComposerAttachment {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  imageInput: boolean;
  dataUrl: string;
}

export interface AttachmentRemoveDetail {
  attachmentId: string;
}

// Three device pixels for each of the 72px a thumbnail takes, so it stays
// sharp on a phone.
const THUMBNAIL_SHORT_SIDE = 216;

/**
 * The pictures and files a draft will send, above its prompt.
 *
 * The Composer owns the list and hands it over each time it draws; the strip
 * keeps one node per attachment, so a picture already shown stays as it is.
 * A thumbnail draws a reduced copy of its picture, never the whole photo.
 */
@customElement("caffold-task-composer-attachments")
export class CaffoldTaskComposerAttachments extends LitElement {
  // The reduced copy drawn for each picture, by attachment id, once made.
  @state()
  private accessor thumbnails: ReadonlyMap<string, string> = new Map();

  private attachments: ComposerAttachment[] = [];
  private thumbnailQueue = Promise.resolve();
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // `attachments` is the Composer's list as it stands. The strip draws it at
  // once, as part of the Composer's own drawing.
  setAttachments(attachments: ComposerAttachment[]) {
    if (attachments === this.attachments) {
      return;
    }
    const added = attachments.filter(
      (attachment) =>
        attachment.imageInput &&
        !this.attachments.some((shown) => shown.id === attachment.id),
    );
    this.attachments = attachments;
    this.thumbnails = new Map(
      [...this.thumbnails].filter(([id]) => this.holds(id)),
    );
    this.requestUpdate();
    this.performUpdate();
    for (const image of added) {
      this.drawThumbnail(image);
    }
  }

  override render() {
    const pictures = this.attachments.filter(({ imageInput }) => imageInput);
    const files = this.attachments.filter(({ imageInput }) => !imageInput);
    return html`
      <div
        class="task-composer-attachments"
        aria-label="Images to send"
        ?hidden=${!pictures.length}
      >${repeat(
        pictures,
        (image) => image.id,
        (image) => this.pictureTemplate(image),
      )}</div>
      <div
        class="task-composer-files"
        aria-label="Files to send"
        ?hidden=${!files.length}
      >${repeat(
        files,
        (file) => file.id,
        (file) => this.fileTemplate(file),
      )}</div>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private pictureTemplate(image: ComposerAttachment) {
    return html`<figure
      class="task-composer-attachment"
      title=${image.name}
    ><button
        ${this.hints.button({
          id: `preview-image:${image.id}`,
          label: `Preview ${image.name}`,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-composer-attachment-preview"
        data-attachment-action="preview-image"
        data-attachment-id=${image.id}
        aria-label=${`Preview ${image.name}`}
        title="Preview image"
        @click=${(event: Event) => this.preview(event, image)}
      ><img
          alt=""
          src=${this.thumbnails.get(image.id) ?? nothing}
        ></button><button
        ${this.hints.button({
          id: `remove-image:${image.id}`,
          label: `Remove ${image.name}`,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-composer-attachment-remove"
        data-attachment-action="remove-image"
        data-attachment-id=${image.id}
        aria-label=${`Remove ${image.name}`}
        title="Remove image"
        @click=${(event: Event) => this.requestRemoval(event, image)}
      >${inlineIcon(
        "X",
        "Remove image",
        "task-composer-attachment-remove-icon",
      )}</button></figure>`;
  }

  // The extension stays whole when a long name is cut short, so a file is
  // still told apart by its kind.
  private fileTemplate(file: ComposerAttachment) {
    const { stem, extension } = splitFileName(file.name);
    return html`<span
      class="task-composer-file"
      title=${file.name}
    >${inlineIcon(
      "File",
      "File",
      "task-composer-file-icon",
    )}<span class="task-composer-file-name"><span
          class="task-composer-file-stem"
        >${stem}</span><span
          class="task-composer-file-extension"
        >${extension}</span></span><button
        ${this.hints.button({
          id: `remove-file:${file.id}`,
          label: `Remove ${file.name}`,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-composer-file-remove"
        data-attachment-action="remove-file"
        data-attachment-id=${file.id}
        aria-label=${`Remove ${file.name}`}
        title="Remove file"
        @click=${(event: Event) => this.requestRemoval(event, file)}
      >${inlineIcon(
        "X",
        "Remove file",
        "task-composer-file-remove-icon",
      )}</button></span>`;
  }

  private preview(event: Event, image: ComposerAttachment) {
    event.stopPropagation();
    requestTaskImagePreview(this, { src: image.dataUrl, name: image.name });
  }

  private requestRemoval(event: Event, attachment: ComposerAttachment) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<AttachmentRemoveDetail>(
        "caffold:task-composer-attachment-remove",
        {
          bubbles: true,
          composed: true,
          detail: { attachmentId: attachment.id },
        },
      ),
    );
  }

  // Pictures are reduced one at a time, so several large photos attached
  // together are not opened all at once. A picture removed in the meantime is
  // left alone.
  private drawThumbnail(image: ComposerAttachment) {
    this.thumbnailQueue = this.thumbnailQueue.then(async () => {
      if (!this.holds(image.id)) {
        return;
      }
      const source = await thumbnailSource(image);
      if (this.holds(image.id)) {
        this.thumbnails = new Map(this.thumbnails).set(image.id, source);
      }
    });
  }

  private holds(id: string) {
    return this.attachments.some((attachment) => attachment.id === id);
  }
}

// The original when it is already small, otherwise a copy whose short side is
// THUMBNAIL_SHORT_SIDE. A picture the browser cannot reduce stays whole.
async function thumbnailSource(image: ComposerAttachment) {
  let picture: ImageBitmap | null = null;
  try {
    picture = await createImageBitmap(image.file);
    const scale =
      THUMBNAIL_SHORT_SIDE / Math.min(picture.width, picture.height);
    if (scale >= 1) {
      return image.dataUrl;
    }
    const canvas = new OffscreenCanvas(
      Math.round(picture.width * scale),
      Math.round(picture.height * scale),
    );
    const context = canvas.getContext("2d");
    if (!context) {
      return image.dataUrl;
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return await blobAsDataUrl(
      await canvas.convertToBlob({ type: "image/png" }),
    );
  } catch {
    return image.dataUrl;
  } finally {
    picture?.close();
  }
}

function blobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(`${reader.result ?? ""}`), {
      once: true,
    });
    reader.addEventListener("error", () => reject(reader.error), {
      once: true,
    });
    reader.readAsDataURL(blob);
  });
}

function splitFileName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: "" };
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-composer-attachments": CaffoldTaskComposerAttachments;
  }
}
