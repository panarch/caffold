import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { type Note, noteDownloadUrl } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import styles from "./download.css.js";

// Download in the Note details popover. It saves the Note's Markdown under the
// file name the server gives it, and is off for an empty Note.
@customElement("caffold-notes-info-download")
export class CaffoldNotesInfoDownload extends CaffoldElement {
  @property({ attribute: false })
  accessor note: Note | null = null;

  static override styles = styles;

  private readonly hints = new ActionHints(this);
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // A link without an address cannot be disabled natively, so an empty Note's
  // link drops its address and names itself a disabled link.
  override render() {
    const noteId = this.note?.content ? this.note.id : null;
    return html`
      <a
        ${this.hints.link({
          id: "download",
          label: "Download",
          action: ACTION_HINT_ACTION.LINK_OPEN,
          when: noteId !== null,
        })}
        class="notes-info-download-link"
        href=${noteId === null ? nothing : noteDownloadUrl(noteId)}
        download
        role=${noteId === null ? "link" : nothing}
        aria-disabled=${noteId === null ? "true" : nothing}
      >
        <span class="notes-info-download-icon" aria-hidden="true">${inlineIcon(
          "Download",
          "",
          "notes-info-download-svg",
        )}</span>
        <span>Download</span>
      </a>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-notes-info-download": CaffoldNotesInfoDownload;
  }
}
