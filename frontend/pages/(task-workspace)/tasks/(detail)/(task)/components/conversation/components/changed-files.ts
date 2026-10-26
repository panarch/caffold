import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { TaskFilePath } from "#tasks/task-format.ts";

// The files a change touched, one row each, kept by identity as the list
// grows.
export class CaffoldTaskChangedFiles extends LitElement {
  static properties = {
    files: { attribute: false, hasChanged: changedFileList },
  };

  declare files: TaskFilePath[];

  constructor() {
    super();
    this.files = [];
  }

  createRenderRoot() {
    return this;
  }

  render() {
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

  updated() {
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

customElements.define("caffold-task-changed-files", CaffoldTaskChangedFiles);
