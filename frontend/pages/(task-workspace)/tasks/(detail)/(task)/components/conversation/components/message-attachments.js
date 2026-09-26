import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../../../../../action-hints.js";
import { requestTaskImagePreview } from "../../../../../components/image-preview-dialog.js";

const ATTACHMENT_ICONS = Object.freeze({
  image: ["FileImage", "Attached image", "task-message-attachment-icon"],
  unavailable: [
    "ImageOff",
    "Image preview unavailable",
    "task-message-attachment-placeholder-icon",
  ],
});

/**
 * The pictures a message carries, each opening a larger preview.
 *
 * A prompt's images and an image the agent generated are shown the same way,
 * so both messages mount this list and hand it only the pictures to show. The
 * message places the list; `align-end` lines the pictures up on the side a
 * prompt sits on.
 */
class CaffoldTaskMessageAttachments extends HTMLElement {
  constructor() {
    super();
    this.attachments = [];
    this.boundClick = (event) => this.handleClick(event);
  }

  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.setAttribute("aria-label", "Attached images");
      this.render();
    }
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.addEventListener("click", this.boundClick);
    void warmIcons().then(() => {
      if (this.connected) {
        this.drawIcons();
      }
    });
  }

  disconnectedCallback() {
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
  }

  /** The pictures to show, each a `src` (empty when unreadable) and a name. */
  setSnapshot({ attachments = [] } = {}) {
    const next = attachments.map((attachment) => ({
      src: `${attachment?.src ?? ""}`,
      name: `${attachment?.name ?? ""}`,
    }));
    if (JSON.stringify(next) === JSON.stringify(this.attachments)) {
      return false;
    }
    this.attachments = next;
    if (this.initialized) {
      this.render();
    }
    return true;
  }

  render() {
    this.innerHTML = this.attachments.map(renderAttachment).join("");
  }

  handleClick(event) {
    const control = event.target.closest?.(
      'button[data-attachment-action="preview"]',
    );
    if (!control || !this.previewButtons().includes(control)) {
      return;
    }
    const attachment = this.attachments[Number(control.dataset.attachmentIndex)];
    if (attachment) {
      requestTaskImagePreview(this, attachment);
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    if (!scopeId || !this.connected || this.hidden) {
      return emptyActionHintScope();
    }
    const targetClipRoots = [this, ...clipRoots].filter(Boolean);
    return {
      blocked: false,
      targets: this.previewButtons().flatMap((control, index) =>
        hasActionHintLayoutBox(control)
          ? [buttonActionHintTarget({
              invalidationOwner: this,
              id: `${scopeId}:preview:${index + 1}`,
              actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              label: control.getAttribute("aria-label") || "Preview image",
              control,
              clipRoots: targetClipRoots,
              isActionable: () =>
                this.connected &&
                this.isConnected &&
                !this.hidden &&
                this.previewButtons()[index] === control &&
                hasActionHintLayoutBox(control),
            })]
          : []
      ),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  // Icons load after the first pictures may already be on screen, so their
  // slots are filled in place once the set is ready.
  drawIcons() {
    for (const slot of this.querySelectorAll("[data-attachment-icon]")) {
      if (!slot.querySelector("svg")) {
        slot.innerHTML = renderAttachmentIcon(slot.dataset.attachmentIcon);
      }
    }
  }

  previewButtons() {
    return Array.from(this.querySelectorAll(
      ':scope > figure > button[data-attachment-action="preview"]',
    ));
  }
}

function renderAttachment(attachment, index) {
  const name = escapeHtml(attachment.name);
  return `
    <figure class="task-message-attachment">
      ${attachment.src ? `
        <button
          type="button"
          class="task-message-attachment-preview"
          data-attachment-action="preview"
          data-attachment-index="${index}"
          aria-label="Preview ${name}"
          title="Preview image"
        >
          <img src="${escapeHtml(attachment.src)}" alt="" loading="lazy">
        </button>
      ` : `
        <div class="task-message-attachment-preview task-message-attachment-unavailable">
          <span class="task-message-attachment-icon-slot" data-attachment-icon="unavailable">${renderAttachmentIcon("unavailable")}</span>
          <span>Preview unavailable</span>
        </div>
      `}
      <figcaption title="${name}">
        <span class="task-message-attachment-icon-slot" data-attachment-icon="image">${renderAttachmentIcon("image")}</span>
        <span class="task-message-attachment-name">${name}</span>
      </figcaption>
    </figure>
  `;
}

function renderAttachmentIcon(kind) {
  const [name, label, className] = ATTACHMENT_ICONS[kind];
  return renderInlineIcon(name, label, className);
}

if (!customElements.get("caffold-task-message-attachments")) {
  customElements.define(
    "caffold-task-message-attachments",
    CaffoldTaskMessageAttachments,
  );
}
