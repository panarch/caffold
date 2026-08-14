class CaffoldTaskChangedFiles extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.initialized) {
      this.initialized = true;
      this.innerHTML = '<ul aria-label="Changed files"></ul>';
    }
    this.update();
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const nextSnapshot = {
      files: (snapshot.files ?? []).map((file) => ({
        fileIdentity: `${file.fileIdentity ?? ""}`,
        originalPath: `${file.originalPath ?? ""}`,
        displayPath: `${file.displayPath ?? ""}`,
      })),
    };
    if (sameSnapshot(this.snapshot, nextSnapshot)) {
      return false;
    }
    this.snapshot = nextSnapshot;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = { files: [] };
  }

  update() {
    const list = this.querySelector(":scope > ul");
    if (!list) {
      return;
    }
    this.hidden = this.snapshot.files.length === 0;
    reconcileFileRows(list, this.snapshot.files);
  }
}

function sameSnapshot(left, right) {
  return Boolean(
    left.files.length === right.files.length &&
      left.files.every((file, index) => {
        const next = right.files[index];
        return (
          file.fileIdentity === next.fileIdentity &&
          file.originalPath === next.originalPath &&
          file.displayPath === next.displayPath
        );
      }),
  );
}

function reconcileFileRows(list, files) {
  const existingRows = new Map(
    [...list.children].map((row) => [row.dataset.fileIdentity, row]),
  );
  const desiredRows = files.map((file) => {
    const row = existingRows.get(file.fileIdentity) ?? createFileRow();
    patchFileRow(row, file);
    return row;
  });
  const desired = new Set(desiredRows);
  for (const row of [...list.children]) {
    if (!desired.has(row)) {
      row.remove();
    }
  }
  let anchor = null;
  for (let index = desiredRows.length - 1; index >= 0; index -= 1) {
    const row = desiredRows[index];
    if (row.parentElement !== list || row.nextElementSibling !== anchor) {
      list.insertBefore(row, anchor);
    }
    anchor = row;
  }
}

function createFileRow() {
  const row = document.createElement("li");
  row.append(document.createElement("code"));
  return row;
}

function patchFileRow(row, file) {
  row.dataset.fileIdentity = file.fileIdentity;
  row.dataset.fileChangePath = file.originalPath;
  const code = row.querySelector(":scope > code");
  if (code.textContent !== file.displayPath) {
    code.textContent = file.displayPath;
  }
  if (file.originalPath === file.displayPath) {
    code.removeAttribute("title");
  } else if (code.getAttribute("title") !== file.originalPath) {
    code.setAttribute("title", file.originalPath);
  }
}

if (!customElements.get("caffold-task-changed-files")) {
  customElements.define(
    "caffold-task-changed-files",
    CaffoldTaskChangedFiles,
  );
}
