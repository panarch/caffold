import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import type { ActionHintPull } from "#app/action-hints.js";
import { type GitDiff, readFile } from "#app/api.js";
import { fileStatusPresentation } from "#app/file-status.js";
import type { ScrollSurfacePull } from "#app/scroll-scope.js";
import { fileNameFromPath, imageTypeLabel } from "#components/dom.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-viewer.js";
import type { ScrollPosition } from "#components/file-viewer/components/code-viewer.js";
import type {
  CaffoldReviewFileViewer,
  FileViewerNoticeActionDetail,
} from "#components/file-viewer.js";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "#components/file-viewer-presentation.js";
import {
  contentFor,
  type ReviewChange,
  type ReviewView,
} from "./selected-file/content.js";

export interface ReviewRepresentationIntentDetail {
  representation: string;
}

interface ViewPosition {
  scroll: ScrollPosition | null;
  line: number | null;
}

@customElement("caffold-review-selected-file")
export class CaffoldReviewSelectedFile extends LitElement {
  private rootPath = "";
  private worktreeRootPath = "";
  private view: ReviewView | null = null;
  private generation = 0;
  private shownStateKey = "";
  private readonly positions = new Map<string, ViewPosition>();
  private readonly viewerElement = new DrawnRef<CaffoldReviewFileViewer>(this);
  private readonly pendingLines = new Map<string, number>();

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
  }

  override render() {
    return html`<caffold-review-file-viewer
      ${drawn(this.viewerElement)}
      compact-chrome
      @caffold:file-viewer-notice-action=${this.chooseRepresentation}
    ></caffold-review-file-viewer>`;
  }

  override firstUpdated() {
    this.viewer.setCloseLabel("Back to navigator");
    this.viewer.setCloseMode("back");
  }

  setContext({
    rootPath = "",
    worktreeRootPath = "",
  }: {
    rootPath?: string;
    worktreeRootPath?: string;
  } = {}) {
    if (
      rootPath === this.rootPath &&
      worktreeRootPath === this.worktreeRootPath
    ) {
      return;
    }
    this.rootPath = rootPath;
    this.worktreeRootPath = worktreeRootPath;
    this.view = null;
    this.generation += 1;
    this.shownStateKey = "";
    this.viewer.setEmpty();
  }

  // `view` names the selected file in its representation, with what the
  // shown Working Tree or Branch changes say about it. `force` loads it even
  // when the viewer already holds something other than an empty or error state.
  show(view: ReviewView, { force = false }: { force?: boolean } = {}) {
    this.rememberPosition(view);
    this.view = view;
    if (!view.path) {
      this.shownStateKey = "";
      this.viewer.setEmpty();
      return;
    }
    if (force || ["empty", "error"].includes(this.viewer.status)) {
      void this.load();
    }
  }

  // A reread loads the view again in the background only when the viewer
  // already shows it, so a first look still shows loading and the line it
  // last left.
  reload(
    view: ReviewView,
    {
      background = false,
      reread = false,
    }: { background?: boolean; reread?: boolean } = {},
  ) {
    this.view = view;
    void this.load({
      background:
        background || (reread && this.shownStateKey === view.stateKey),
    });
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.viewer.actionHintScope(pull);
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.viewer.scrollSurfaceScope(pull);
  }

  keyboardNavigationContexts(options: { scopeId?: string } = {}) {
    return this.viewer.keyboardNavigationContexts(options);
  }

  private chooseRepresentation(
    event: CustomEvent<FileViewerNoticeActionDetail>,
  ) {
    const { action } = event.detail;
    if (action !== "view-source" && action !== "view-preview") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ReviewRepresentationIntentDetail>(
        "caffold:review-representation-intent",
        {
          bubbles: true,
          detail: {
            representation: action === "view-preview" ? "preview" : "source",
          },
        },
      ),
    );
  }

  private async load({ background = false }: { background?: boolean } = {}) {
    const view = this.view;
    const viewer = this.viewer;
    if (!view?.path) {
      this.shownStateKey = "";
      viewer.setEmpty();
      return;
    }
    const generation = ++this.generation;
    const { stateKey, logicalPath, line } = view;
    // A background load follows a change the watch reported for the file, a
    // recovered watch, or a reread of Git data while the view is on screen:
    // it keeps the reading position and asks again whether a previewed file
    // changed. Any other load shows the file the viewer already holds.
    if (!background) {
      this.shownStateKey = "";
    }
    const content = contentFor(view);
    if (content.kind === "unchanged") {
      return;
    }
    if (content.kind === "notice") {
      this.shownStateKey = "";
      viewer.setNotice(content.message, content.options);
      return;
    }
    if (content.kind === "loading" || content.kind === "error") {
      this.shownStateKey = "";
      const presentation = this.diffPresentation(view, null);
      if (content.kind === "error") {
        viewer.setError(presentation, content.error as Error);
      } else {
        viewer.setLoading(presentation);
      }
      return;
    }
    if (content.kind === "document") {
      viewer.setDocument(
        {
          kind: content.documentKind,
          path: logicalPath,
          name: fileNameFromPath(logicalPath),
          size: view.entry?.size,
          modifiedMs: view.entry?.modifiedMs,
        },
        { recheck: background },
      );
      this.shownStateKey = stateKey;
      return;
    }
    if (content.kind === "image") {
      viewer.setImage(
        {
          path: logicalPath,
          name: fileNameFromPath(logicalPath),
          imageType: imageTypeLabel(logicalPath),
          size: view.entry?.size,
          modifiedMs: view.entry?.modifiedMs,
        },
        { recheck: background },
      );
      this.shownStateKey = stateKey;
      return;
    }
    const sourceLine = content.kind === "file" ? line : null;
    const saved = this.positions.get(stateKey);
    const presentation =
      content.kind === "diff"
        ? this.diffPresentation(view, content.change)
        : sourceViewerPresentation({ path: logicalPath });
    if (!background) {
      viewer.setLoading(presentation);
    }
    const viewerOptions = background
      ? { preserveScroll: true }
      : sourceLine
        ? { line: sourceLine }
        : { scroll: saved?.scroll ?? null };
    try {
      if (content.kind === "diff") {
        const diff = await view.changes.readDiff?.();
        if (!diff || !this.acceptsLoad(generation, logicalPath)) {
          return;
        }
        viewer.setDiff(diff, {
          ...viewerOptions,
          presentation: this.diffPresentation(view, content.change, diff),
        });
      } else {
        const file = await readFile(logicalPath);
        if (!this.acceptsLoad(generation, logicalPath)) {
          return;
        }
        if (content.kind === "markdown") {
          viewer.setMarkdown(file, {
            ...viewerOptions,
            imageRoot: this.rootPath,
          });
        } else {
          viewer.setFile(file, viewerOptions);
        }
      }
      this.shownStateKey = stateKey;
      if (!background && !sourceLine) {
        this.restorePosition(stateKey, saved);
      }
    } catch (error) {
      if (this.acceptsLoad(generation, logicalPath)) {
        this.shownStateKey = "";
        viewer.setError(presentation, error as Error);
      }
    }
  }

  private diffPresentation(
    view: ReviewView,
    change: ReviewChange | null,
    diff: GitDiff = {},
  ) {
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? { rootPath: this.worktreeRootPath },
      path: diff.path ?? view.logicalPath,
      repoRelativePath: diff.repoRelativePath ?? view.path,
      kind: diff.kind || view.changes.diffKind || change?.kind || "",
      status: change
        ? fileStatusPresentation(
            change.file.status,
            "category" in change.file ? change.file : null,
          ).code
        : "",
    });
  }

  private acceptsLoad(generation: number, logicalPath: string) {
    return (
      this.isConnected &&
      generation === this.generation &&
      logicalPath === this.view?.logicalPath
    );
  }

  // Leaving a view keeps its position for a later return. Switching only the
  // representation of the same file carries the visible line to the new one.
  private rememberPosition(nextView: ReviewView) {
    const previous = this.view;
    if (!previous?.path || previous.stateKey === nextView.stateKey) {
      return;
    }
    const line = this.viewer.visibleLine();
    this.positions.set(previous.stateKey, {
      scroll: this.viewer.captureContentScroll(),
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

  private restorePosition(stateKey: string, saved: ViewPosition | undefined) {
    const line = saved?.line ?? this.pendingLines.get(stateKey);
    if (!line) {
      return;
    }
    this.pendingLines.delete(stateKey);
    requestAnimationFrame(() => {
      this.viewer.scrollToLine(line);
      window.setTimeout(() => this.viewer.scrollToLine(line), 40);
    });
  }

  // The viewer is drawn the first time it is needed, which can be before the
  // selected file is in the document.
  private get viewer() {
    this.performUpdate();
    return this.viewerElement.value as CaffoldReviewFileViewer;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-review-selected-file": CaffoldReviewSelectedFile;
  }

  interface HTMLElementEventMap {
    "caffold:review-representation-intent": CustomEvent<ReviewRepresentationIntentDetail>;
  }
}
