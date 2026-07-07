import "../../components/file-browser.js";

class CaffoldFilesPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `<caffold-file-browser external-navigation></caffold-file-browser>`;
    this.fileBrowser = this.querySelector("caffold-file-browser");
    this.fileBrowser.ensureRendered();
  }

  get currentPath() {
    this.ensureRendered();
    return this.fileBrowser.currentPath;
  }

  get lastError() {
    this.ensureRendered();
    return this.fileBrowser.lastError;
  }

  loadDirectory(path, options = {}) {
    this.ensureRendered();
    return this.fileBrowser.loadDirectory(path, options);
  }

  openPath(path, options = {}) {
    this.ensureRendered();
    return this.fileBrowser.openPath(path, options);
  }

  openFile(path, entry = null) {
    this.ensureRendered();
    return this.fileBrowser.openFile(path, entry);
  }

  showList() {
    this.ensureRendered();
    this.fileBrowser.showList();
  }

  clearSelectedFile(options = {}) {
    this.ensureRendered();
    this.fileBrowser.clearSelectedFile(options);
  }

  entryForPath(path) {
    this.ensureRendered();
    return this.fileBrowser.entryForPath(path);
  }

  setStorageKey(key) {
    this.ensureRendered();
    this.fileBrowser.setStorageKey(key);
  }

  loadStoredDirectoryPath() {
    this.ensureRendered();
    return this.fileBrowser.loadStoredDirectoryPath();
  }

  setError(error) {
    this.ensureRendered();
    this.fileBrowser.setError(error);
  }

  isFileViewer(target) {
    this.ensureRendered();
    return this.fileBrowser.isFileViewer(target);
  }
}

customElements.define("caffold-files-page", CaffoldFilesPage);
