// The pictures and files a draft will send, above its prompt. The Composer
// owns the list; the strip keeps one node per attachment, so a picture already
// shown stays as it is however often the Composer is drawn again. A thumbnail
// draws a reduced copy of its picture, never the whole photo.

import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import { escapeHtml } from "#components/dom.js";
import { renderInlineIcon } from "#components/icons.js";
import { requestTaskImagePreview } from "../../image-preview-dialog.js";

const ATTACHMENT_ACTIONS = ["preview-image", "remove-image", "remove-file"];
// Three device pixels for each of the 72px a thumbnail takes, so it stays
// sharp on a phone.
const THUMBNAIL_SHORT_SIDE = 216;

class CaffoldTaskComposerAttachments extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  disconnectedCallback() {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  // `attachments` is the Composer's list as it stands. Only what it adds,
  // drops, or reorders changes here.
  setAttachments(attachments = []) {
    this.ensureRendered();
    this.attachments = [...attachments];
    const nodes = new Map();
    const pictures = [];
    const files = [];
    const added = [];
    for (const attachment of this.attachments) {
      let node = this.nodes.get(attachment.id);
      if (!node) {
        node = attachmentNode(attachment);
        added.push([attachment, node]);
      }
      nodes.set(attachment.id, node);
      (attachment.imageInput ? pictures : files).push(node);
    }
    for (const [id, node] of this.nodes) {
      if (!nodes.has(id)) {
        node.remove();
      }
    }
    this.nodes = nodes;
    placeInOrder(this.pictureList(), pictures);
    placeInOrder(this.fileList(), files);
    for (const [attachment, node] of added) {
      if (attachment.imageInput) {
        this.drawThumbnail(attachment, node);
      }
    }
  }

  // Pictures are reduced one at a time, so several large photos attached
  // together are not opened all at once. A picture removed in the meantime is
  // left alone.
  drawThumbnail(image, node) {
    const shown = () => this.nodes.get(image.id) === node;
    this.thumbnails = this.thumbnails.then(async () => {
      if (!shown()) {
        return;
      }
      const source = await thumbnailSource(image);
      if (shown()) {
        node.querySelector("img").src = source;
      }
    });
  }

  // Preview and Remove for each attachment, in Action Hints beside the
  // Composer's own buttons.
  actionHintTargets({ scopeId, clipRoots = [] } = {}) {
    if (!scopeId) {
      return [];
    }
    return ATTACHMENT_ACTIONS.flatMap((action) =>
      Array.from(
        this.querySelectorAll(`button[data-attachment-action="${action}"]`),
        (control) => this.actionHintTarget(control, { scopeId, clipRoots }),
      ).filter(Boolean)
    );
  }

  actionHintTarget(control, { scopeId, clipRoots }) {
    const { attachmentAction: action, attachmentId: id } = control.dataset;
    if (!id || control.disabled || !hasActionHintLayoutBox(control)) {
      return null;
    }
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: `task-composer:${scopeId}:${action}:${id}`,
      actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      label: control.getAttribute("aria-label") || control.title || `${action}:${id}`,
      control,
      clipRoots: [...clipRoots],
      isActionable: () =>
        this.isConnected &&
        Boolean(this.nodes.get(id)?.contains(control)) &&
        !control.disabled &&
        hasActionHintLayoutBox(control),
    });
  }

  handleClick(event) {
    const control = event.target instanceof Element
      ? event.target.closest("button[data-attachment-action]")
      : null;
    if (!control || !this.contains(control)) {
      return;
    }
    event.stopPropagation();
    const attachment = this.attachments.find(
      (candidate) => candidate.id === control.dataset.attachmentId,
    );
    if (!attachment) {
      return;
    }
    if (control.dataset.attachmentAction === "preview-image") {
      requestTaskImagePreview(this, { src: attachment.dataUrl, name: attachment.name });
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-composer-attachment-remove", {
        bubbles: true,
        composed: true,
        detail: { attachmentId: attachment.id },
      }),
    );
  }

  pictureList() {
    return this.querySelector(":scope > .task-composer-attachments");
  }

  fileList() {
    return this.querySelector(":scope > .task-composer-files");
  }

  ensureRendered() {
    if (this.pictureList()) {
      return;
    }
    this.attachments = [];
    this.nodes = new Map();
    this.thumbnails = Promise.resolve();
    this.boundClick = (event) => this.handleClick(event);
    // Icons drawn before the icon set arrived are only their labels.
    this.boundIconsReady = () => {
      for (const node of this.nodes.values()) {
        drawIcons(node);
      }
    };
    this.innerHTML = `
      <div class="task-composer-attachments" aria-label="Images to send" hidden></div>
      <div class="task-composer-files" aria-label="Files to send" hidden></div>
    `;
  }
}

function attachmentNode(attachment) {
  const node = attachment.imageInput
    ? pictureNode(attachment)
    : fileNode(attachment);
  drawIcons(node);
  return node;
}

function pictureNode(image) {
  const name = escapeHtml(image.name);
  const id = escapeHtml(image.id);
  const figure = document.createElement("figure");
  figure.className = "task-composer-attachment";
  figure.title = image.name;
  figure.innerHTML = `<button
      type="button"
      class="task-composer-attachment-preview"
      data-attachment-action="preview-image"
      data-attachment-id="${id}"
      aria-label="Preview ${name}"
      title="Preview image"
    ><img alt=""></button><button
      type="button"
      class="task-composer-attachment-remove"
      data-attachment-action="remove-image"
      data-attachment-id="${id}"
      aria-label="Remove ${name}"
      title="Remove image"
    ></button>`;
  return figure;
}

// The original when it is already small, otherwise a copy whose short side is
// THUMBNAIL_SHORT_SIDE. A picture the browser cannot reduce stays whole.
async function thumbnailSource(image) {
  let picture = null;
  try {
    picture = await createImageBitmap(image.file);
    const scale = THUMBNAIL_SHORT_SIDE / Math.min(picture.width, picture.height);
    if (scale >= 1) {
      return image.dataUrl;
    }
    const canvas = new OffscreenCanvas(
      Math.round(picture.width * scale),
      Math.round(picture.height * scale),
    );
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return await blobAsDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  } catch {
    return image.dataUrl;
  } finally {
    picture?.close();
  }
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(`${reader.result ?? ""}`), {
      once: true,
    });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

// The extension stays whole when a long name is cut short, so a file is still
// told apart by its kind.
function fileNode(file) {
  const { stem, extension } = splitFileName(file.name);
  const chip = document.createElement("span");
  chip.className = "task-composer-file";
  chip.title = file.name;
  chip.innerHTML = `<span class="task-composer-file-name"><span class="task-composer-file-stem">${escapeHtml(stem)}</span><span class="task-composer-file-extension">${escapeHtml(extension)}</span></span><button
      type="button"
      class="task-composer-file-remove"
      data-attachment-action="remove-file"
      data-attachment-id="${escapeHtml(file.id)}"
      aria-label="Remove ${escapeHtml(file.name)}"
      title="Remove file"
    ></button>`;
  return chip;
}

function drawIcons(node) {
  const remove = node.querySelector(".task-composer-attachment-remove");
  if (remove) {
    remove.innerHTML = renderInlineIcon("X", "Remove image", "task-composer-attachment-remove-icon");
    return;
  }
  const name = node.querySelector(":scope > .task-composer-file-name");
  while (name.previousSibling) {
    name.previousSibling.remove();
  }
  name.insertAdjacentHTML("beforebegin", renderInlineIcon("File", "File", "task-composer-file-icon"));
  node.querySelector(".task-composer-file-remove").innerHTML =
    renderInlineIcon("X", "Remove file", "task-composer-file-remove-icon");
}

function splitFileName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: "" };
}

// Each node keeps its place unless the list moved it; an empty list is hidden.
function placeInOrder(list, nodes) {
  nodes.forEach((node, index) => {
    const current = list.children[index] ?? null;
    if (current !== node) {
      list.insertBefore(node, current);
    }
  });
  list.hidden = !nodes.length;
}

if (!customElements.get("caffold-task-composer-attachments")) {
  customElements.define(
    "caffold-task-composer-attachments",
    CaffoldTaskComposerAttachments,
  );
}
