import { readFile } from "#app/api.js";
import { fileStatusPresentation } from "#app/file-status.ts";
import { fileNameFromPath, imageTypeLabel } from "#components/dom.ts";
import "#components/file-viewer.ts";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "#components/file-viewer-presentation.ts";
import { contentFor } from "./selected-file/content.js";

class CaffoldReviewSelectedFile extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.viewer()?.deactivate?.();
    this.generation += 1;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.rootPath = "";
    this.worktreeRootPath = "";
    this.view = null;
    this.generation = 0;
    this.shownStateKey = "";
    this.positions = new Map();
    this.pendingLines = new Map();

    this.innerHTML = `<caffold-review-file-viewer compact-chrome></caffold-review-file-viewer>`;
    this.viewer()?.setCloseLabel("Back to navigator");
    this.viewer()?.setCloseMode("back");

    this.addEventListener("click", (event) => {
      const action = event.target instanceof Element
        ? event.target.closest('[data-action="view-source"], [data-action="view-preview"]')
        : null;
      if (!action || !this.contains(action)) {
        return;
      }
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:review-representation-intent", {
          bubbles: true,
          detail: {
            representation: action.dataset.action === "view-preview" ? "preview" : "source",
          },
        }),
      );
    });
  }

  setContext({ rootPath = "", worktreeRootPath = "" } = {}) {
    this.ensureRendered();
    if (rootPath === this.rootPath && worktreeRootPath === this.worktreeRootPath) {
      return;
    }
    this.rootPath = rootPath;
    this.worktreeRootPath = worktreeRootPath;
    this.view = null;
    this.generation += 1;
    this.shownStateKey = "";
    this.viewer()?.setEmpty();
  }

  // `view` names the selected file in its representation, with what the
  // shown Working Tree or Branch changes say about it. `force` loads it even
  // when the viewer already holds something other than an empty or error state.
  show(view, { force = false } = {}) {
    this.ensureRendered();
    this.rememberPosition(view);
    this.view = view;
    if (!view.path) {
      this.shownStateKey = "";
      this.viewer()?.setEmpty();
      return;
    }
    if (force || ["empty", "error"].includes(this.viewer()?.state?.status)) {
      void this.load();
    }
  }

  // A reread loads the view again in the background only when the viewer
  // already shows it, so a first look still shows loading and the line it
  // last left.
  reload(view, { background = false, reread = false } = {}) {
    this.ensureRendered();
    this.view = view;
    void this.load({
      background: background || (reread && this.shownStateKey === view.stateKey),
    });
  }

  actionHintScope(options = {}) {
    return this.viewer()?.actionHintScope(options);
  }

  scrollSurfaceScope(options = {}) {
    return this.viewer()?.scrollSurfaceScope(options);
  }

  keyboardNavigationContexts(options = {}) {
    return this.viewer()?.keyboardNavigationContexts(options) ?? [];
  }

  async load(options = {}) {
    const view = this.view;
    const viewer = this.viewer();
    if (!view?.path) {
      this.shownStateKey = "";
      viewer?.setEmpty();
      return;
    }
    const generation = ++this.generation;
    const { stateKey, logicalPath, line } = view;
    // A background load follows a change the watch reported for the file, a
    // recovered watch, or a reread of Git data while the view is on screen:
    // it keeps the reading position and asks again whether a previewed file
    // changed. Any other load shows the file the viewer already holds.
    const background = Boolean(options.background);
    if (!background) {
      this.shownStateKey = "";
    }
    const content = contentFor(view);
    if (content.kind === "unchanged") {
      return;
    }
    if (content.kind === "notice") {
      this.shownStateKey = "";
      viewer?.setNotice(content.message, content.options);
      return;
    }
    if (content.kind === "loading" || content.kind === "error") {
      this.shownStateKey = "";
      const presentation = this.diffPresentation(view, null);
      if (content.kind === "error") {
        viewer?.setError(presentation, content.error);
      } else {
        viewer?.setLoading(presentation);
      }
      return;
    }
    if (content.kind === "document") {
      viewer?.setDocument({
        kind: content.documentKind,
        path: logicalPath,
        name: fileNameFromPath(logicalPath),
        size: view.entry?.size,
        modifiedMs: view.entry?.modifiedMs,
      }, { recheck: background });
      this.shownStateKey = stateKey;
      return;
    }
    if (content.kind === "image") {
      viewer?.setImage({
        path: logicalPath,
        name: fileNameFromPath(logicalPath),
        imageType: imageTypeLabel(logicalPath),
        size: view.entry?.size,
        modifiedMs: view.entry?.modifiedMs,
      }, { recheck: background });
      this.shownStateKey = stateKey;
      return;
    }
    const sourceLine = content.kind === "file" ? line : null;
    const saved = this.positions.get(stateKey);
    const presentation = content.kind === "diff"
      ? this.diffPresentation(view, content.change)
      : sourceViewerPresentation({ path: logicalPath });
    if (!background) {
      viewer?.setLoading(presentation);
    }
    const viewerOptions = background
      ? { preserveScroll: true }
      : sourceLine
        ? { line: sourceLine }
        : { scroll: saved?.scroll ?? null };
    try {
      if (content.kind === "diff") {
        const diff = await view.changes.readDiff();
        if (!this.acceptsLoad(generation, logicalPath)) {
          return;
        }
        viewer?.setDiff(diff, {
          ...viewerOptions,
          presentation: this.diffPresentation(view, content.change, diff),
        });
      } else {
        const file = await readFile(logicalPath);
        if (!this.acceptsLoad(generation, logicalPath)) {
          return;
        }
        if (content.kind === "markdown") {
          viewer?.setMarkdown(file, { ...viewerOptions, imageRoot: this.rootPath });
        } else {
          viewer?.setFile(file, viewerOptions);
        }
      }
      this.shownStateKey = stateKey;
      if (!background && !sourceLine) {
        this.restorePosition(stateKey, saved);
      }
    } catch (error) {
      if (this.acceptsLoad(generation, logicalPath)) {
        this.shownStateKey = "";
        viewer?.setError(presentation, error);
      }
    }
  }

  diffPresentation(view, change, diff = {}) {
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? { rootPath: this.worktreeRootPath },
      path: diff.path ?? view.logicalPath,
      repoRelativePath: diff.repoRelativePath ?? view.path,
      kind: diff.kind || view.changes.diffKind || change?.kind || "",
      status: change?.file
        ? fileStatusPresentation(change.file.status, change.file).code
        : "",
    });
  }

  acceptsLoad(generation, logicalPath) {
    return (
      this.isConnected &&
      generation === this.generation &&
      logicalPath === this.view?.logicalPath
    );
  }

  // Leaving a view keeps its position for a later return. Switching only the
  // representation of the same file carries the visible line to the new one.
  rememberPosition(nextView) {
    const previous = this.view;
    if (!previous?.path || previous.stateKey === nextView.stateKey) {
      return;
    }
    const line = this.viewer()?.visibleLine?.() ?? null;
    this.positions.set(previous.stateKey, {
      scroll: this.viewer()?.captureContentScroll?.() ?? null,
      line,
    });
    if (
      line &&
      previous.scope === nextView.scope &&
      previous.path === nextView.path &&
      previous.representation !== nextView.representation
    ) {
      this.pendingLines.set(nextView.stateKey, line);
    }
  }

  restorePosition(stateKey, saved) {
    const line = saved?.line ?? this.pendingLines.get(stateKey);
    if (!line) {
      return;
    }
    this.pendingLines.delete(stateKey);
    requestAnimationFrame(() => {
      this.viewer()?.scrollToLine(line);
      window.setTimeout(() => this.viewer()?.scrollToLine(line), 40);
    });
  }

  viewer() {
    return this.querySelector(":scope > caffold-review-file-viewer");
  }
}

if (!customElements.get("caffold-review-selected-file")) {
  customElements.define("caffold-review-selected-file", CaffoldReviewSelectedFile);
}
