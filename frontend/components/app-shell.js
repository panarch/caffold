import { getHealth, listDirectory, readFile } from "../api.js";
import "./pathbar.js";
import "./file-list.js";
import "./file-viewer.js";

const LOADING_DELAY_MS = 180;

class CodgerAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.currentPath = "";
    this.directoryRequestId = 0;
    this.fileRequestId = 0;
    this.render();
    this.pathbar = this.querySelector("codger-pathbar");
    this.fileList = this.querySelector("codger-file-list");
    this.fileViewer = this.querySelector("codger-file-viewer");

    this.addEventListener("codger:navigate", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-directory", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-file", (event) => {
      this.openFile(event.detail.path);
    });

    this.bootstrap();
  }

  render() {
    this.innerHTML = `
      <header class="app-header">
        <div class="brand">
          <strong>Codger</strong>
        </div>
      </header>
      <codger-pathbar></codger-pathbar>
      <main class="app-main" aria-label="File browser">
        <codger-file-list></codger-file-list>
        <codger-file-viewer></codger-file-viewer>
      </main>
    `;
  }

  async bootstrap() {
    this.fileViewer.setEmpty();

    try {
      const health = await getHealth();
      this.pathbar.homePath = health.homePath ?? null;
      await this.loadDirectory(health.initialPath ?? "");
    } catch (error) {
      this.fileList.setError(error);
      this.fileViewer.setError("", error);
    }
  }

  async loadDirectory(path) {
    const requestId = ++this.directoryRequestId;
    this.fileRequestId += 1;
    this.currentPath = path ?? "";
    this.fileList.setSelectedPath("");
    this.pathbar.path = this.currentPath;
    this.fileViewer.setEmpty();
    const loadingTimer = this.showDirectoryLoadingAfterDelay(requestId);

    try {
      const directory = await listDirectory(this.currentPath);
      if (requestId !== this.directoryRequestId) {
        return;
      }

      this.currentPath = directory.path;
      this.pathbar.path = directory.path;
      this.fileList.setDirectory(directory);
    } catch (error) {
      if (requestId !== this.directoryRequestId) {
        return;
      }

      this.fileList.setError(error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openFile(path) {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath(path);
    const loadingTimer = this.showFileLoadingAfterDelay(path, requestId);

    try {
      const file = await readFile(path);
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setFile(file);
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showDirectoryLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.directoryRequestId) {
        this.fileList.setLoading();
      }
    }, LOADING_DELAY_MS);
  }

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }
}

customElements.define("codger-app-shell", CodgerAppShell);
