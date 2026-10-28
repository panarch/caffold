import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { TaskFilePath } from "#tasks/task-format.js";

import styles from "./changed-files.css.js";

// The files a change touched, one row each, kept by identity as the list
// grows.
@customElement("caffold-task-changed-files")
export class CaffoldTaskChangedFiles extends CaffoldElement {
  @property({ attribute: false, hasChanged: changedFileList })
  accessor files: TaskFilePath[] = [];

  static override styles = styles;

  override render() {
    return html`<ul aria-label="Changed files">${repeat(
      this.files,
      (file) => file.fileIdentity,
      (file) => {
        const title =
          file.originalPath === file.displayPath ? nothing : file.originalPath;
        return html`<li
          data-file-identity=${file.fileIdentity}
          data-file-change-path=${file.originalPath}
        ><code title=${title}>${file.displayPath}</code></li>`;
      },
    )}</ul>`;
  }

  override updated() {
    const hidden = this.files.length === 0;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }
}

function changedFileList(next: TaskFilePath[], previous?: TaskFilePath[]) {
  return (
    !previous ||
    next.length !== previous.length ||
    next.some((file, index) => {
      const before = previous[index];
      return (
        file.fileIdentity !== before.fileIdentity ||
        file.originalPath !== before.originalPath ||
        file.displayPath !== before.displayPath
      );
    })
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-changed-files": CaffoldTaskChangedFiles;
  }
}
