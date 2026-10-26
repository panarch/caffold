import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { ActionHintScope } from "../action-hint-scope.ts";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.ts";
import { documentUrl, downloadUrl, imageUrl } from "../api.ts";
import { type FetchedFile, fetchInChunks } from "../chunked-fetch.ts";
import { compactIconButton } from "../component-styles.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  KeyboardContexts,
} from "../keyboard-navigation.ts";
import "../keyboard-navigation/components/presentation.ts";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
  ScrollSurfaces,
} from "../scroll-scope.ts";
import "./docx-viewer.ts";
import {
  type DocumentPreviewFile,
  type DocumentPreviewKind,
  formatBytes,
  formatLineStats,
  formatModified,
} from "./dom.ts";
import "./file-viewer/components/code-viewer.ts";
import type {
  CaffoldCodeViewer,
  CodeFile,
  ScrollPosition,
  ViewerPosition,
  ViewerPositionOptions,
} from "./file-viewer/components/code-viewer.ts";
import "./file-viewer/components/diff-viewer.ts";
import type {
  CaffoldDiffViewer,
  FileDiff,
} from "./file-viewer/components/diff-viewer.ts";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
  type ViewerDiff,
  type ViewerPresentation,
  type ViewerSource,
} from "./file-viewer-presentation.ts";
import { inlineIcon, warmIcons } from "./icons.ts";
import "./loading-text.ts";
import "./markdown-preview.ts";
import type { CaffoldMarkdownPreview } from "./markdown-preview.ts";
import "./pdf-viewer.ts";
import "./pptx-viewer.ts";
import "./xlsx-viewer.ts";
import { DrawnRef, drawn } from "./drawn-refs.ts";

// How long switching to another file keeps showing the previous one before
// the loading state replaces it.
const RETAINED_CONTENT_MS = 180;

// A document preview hands its file to the viewer of its kind.
const DOCUMENT_VIEWERS: Record<
  DocumentPreviewKind,
  (
    file: DocumentPreviewFile | null,
    viewer: DrawnRef<DocumentViewer>,
  ) => TemplateResult
> = {
  pdf: (file, viewer) =>
    html`<caffold-pdf-viewer
      ${drawn(viewer)}
      .file=${file}
    ></caffold-pdf-viewer>`,
  docx: (file, viewer) =>
    html`<caffold-docx-viewer
      ${drawn(viewer)}
      .file=${file}
    ></caffold-docx-viewer>`,
  pptx: (file, viewer) =>
    html`<caffold-pptx-viewer
      ${drawn(viewer)}
      .file=${file}
    ></caffold-pptx-viewer>`,
  xlsx: (file, viewer) =>
    html`<caffold-xlsx-viewer
      ${drawn(viewer)}
      .file=${file}
    ></caffold-xlsx-viewer>`,
};

// An image or document preview is fetched here, once for its file, and drawn
// from that copy. Review asks for it again only when the file may have
// changed, and it is drawn again only when the server answers with another
// version. One preview file at a time moves through these phases; with none,
// nothing is fetched or drawn.
const PREVIEW_PHASE = Object.freeze({
  // Fetched for the first time; nothing of it is drawn yet.
  READING: "reading",
  // Drawn from a fetched copy.
  SHOWN: "shown",
  // Drawn, and asked for again.
  RECHECKING: "rechecking",
  // Its first fetch failed; showing it again fetches it again.
  FAILED: "failed",
});

const PREVIEW_EVENT = Object.freeze({
  // Review says the file may have changed.
  RECHECK: "recheck",
  // The fetch answered with the file and the version the server named.
  READ: "read",
  FAILED: "failed",
});

type PreviewPhase = (typeof PREVIEW_PHASE)[keyof typeof PREVIEW_PHASE];
type PreviewEvent = (typeof PREVIEW_EVENT)[keyof typeof PREVIEW_EVENT];

type PreviewMove =
  | { event: typeof PREVIEW_EVENT.RECHECK }
  | { event: typeof PREVIEW_EVENT.READ; answer: FetchedFile }
  | { event: typeof PREVIEW_EVENT.FAILED };

// The complete set of allowed moves; any other event leaves the phase alone.
// Showing another file, another kind of content, or deactivating lets the
// preview file go, and showing it again starts over.
const PREVIEW_EDGES: Readonly<
  Record<PreviewPhase, Readonly<Partial<Record<PreviewEvent, PreviewPhase>>>>
> = Object.freeze({
  [PREVIEW_PHASE.READING]: Object.freeze({
    [PREVIEW_EVENT.RECHECK]: PREVIEW_PHASE.READING,
    [PREVIEW_EVENT.READ]: PREVIEW_PHASE.SHOWN,
    [PREVIEW_EVENT.FAILED]: PREVIEW_PHASE.FAILED,
  }),
  [PREVIEW_PHASE.SHOWN]: Object.freeze({
    [PREVIEW_EVENT.RECHECK]: PREVIEW_PHASE.RECHECKING,
  }),
  [PREVIEW_PHASE.RECHECKING]: Object.freeze({
    [PREVIEW_EVENT.RECHECK]: PREVIEW_PHASE.RECHECKING,
    [PREVIEW_EVENT.READ]: PREVIEW_PHASE.SHOWN,
    // The copy already drawn stays; the next recheck asks again.
    [PREVIEW_EVENT.FAILED]: PREVIEW_PHASE.SHOWN,
  }),
  [PREVIEW_PHASE.FAILED]: Object.freeze({}),
});

interface PreviewFile {
  url: string;
  phase: PreviewPhase;
  fetching: AbortController | null;
  file: Blob | null;
  version: string | null;
  objectUrl: string;
  // A recheck asked for while the file is on its way runs after it arrives.
  recheckAfter: boolean;
}

interface PreviewImage {
  path: string;
  name: string;
  imageType: string;
  size?: number | null;
  modifiedMs?: number | null;
}

interface PreviewDocument extends ViewerSource {
  kind: DocumentPreviewKind;
  path: string;
}

// What the viewer of every document kind offers.
interface DocumentViewer extends HTMLElement {
  scrollSurfaceScope(pull: ScrollSurfacePull): ScrollSurfaceScope;
  actionHintScope?(pull: ActionHintPull): ActionHintScope;
}

type ViewerState =
  | { status: "empty" }
  | {
      status: "loading";
      presentation: ViewerPresentation | null;
      waited: boolean;
    }
  | { status: "error"; presentation: ViewerPresentation | null; error: Error }
  | {
      status: "notice";
      message: string;
      actionLabel: string;
      action: string;
      title: string;
    }
  | {
      status: "file";
      presentation: ViewerPresentation;
      file: CodeFile;
      position: ViewerPosition;
    }
  | { status: "markdown"; presentation: ViewerPresentation }
  | { status: "image"; image: PreviewImage; presentation: ViewerPresentation }
  | {
      status: "document";
      document: PreviewDocument;
      presentation: ViewerPresentation;
    }
  | {
      status: "diff";
      presentation: ViewerPresentation;
      diff: FileDiff;
      position: ViewerPosition;
    };

interface RetainedContent {
  presentation: ViewerPresentation | null;
  timer: number;
}

let viewerInstanceId = 0;

export class CaffoldReviewFileViewer extends LitElement {
  static properties = {
    state: { state: true },
    closeLabel: { state: true },
    closeMode: { state: true },
    imageDrawn: { state: true },
    imageSource: { state: true },
    documentFile: { state: true },
  };

  declare private state: ViewerState;
  declare private closeLabel: string;
  declare private closeMode: "back" | "close";
  // Until the picture is drawn, its place says it is loading rather than
  // showing an empty image the browser would draw as broken.
  declare private imageDrawn: boolean;
  // The fetched copy of the previewed file the image or document draws from.
  declare private imageSource: string;
  declare private documentFile: DocumentPreviewFile | null;
  private readonly detailsPopoverId: string;
  private previewFile: PreviewFile | null = null;
  private retainedContent: RetainedContent | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, () => this.performUpdate());
  private readonly surfaces = new ScrollSurfaces(this, () =>
    this.performUpdate(),
  );
  private readonly keyboard = new KeyboardContexts(this, () =>
    this.performUpdate(),
  );
  private readonly detailsPopover = new DrawnRef<HTMLElement>(this);
  private readonly imageStage = new DrawnRef<HTMLDivElement>(this);
  private readonly noticeContent = new DrawnRef<HTMLDivElement>(this);
  private readonly codeViewer = new DrawnRef<CaffoldCodeViewer>(this);
  private readonly diffViewer = new DrawnRef<CaffoldDiffViewer>(this);
  private readonly preview = new DrawnRef<CaffoldMarkdownPreview>(this);
  private readonly documentViewer = new DrawnRef<DocumentViewer>(this);

  constructor() {
    super();
    this.state = { status: "empty" };
    this.closeLabel = "Back to files";
    this.closeMode = "close";
    this.imageDrawn = false;
    this.imageSource = "";
    this.documentFile = null;
    viewerInstanceId += 1;
    this.detailsPopoverId = `caffold-viewer-details-${viewerInstanceId}`;
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) => {
      if (event.target === this.detailsPopover.value) {
        this.closeDetailsPopover();
      }
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const state = this.state;
    if (state.status === "empty") {
      return html`
        <section class="viewer-panel empty-panel">
          <p>Select a file to inspect it.</p>
        </section>
      `;
    }
    const presentation: ViewerPresentation | null =
      state.status === "notice" ? { title: state.title } : state.presentation;
    const title = presentation?.title || "File";
    const subtitle = presentation?.subtitle ?? "";
    const lineStats = presentation?.lineStats ?? null;
    const lineCounts = formatLineStats(lineStats);
    const metadata = presentation?.metadata ?? [];
    const downloadPath = presentation?.downloadPath ?? "";
    const details = Boolean(subtitle || lineStats || metadata.length > 0);
    const closeIcon = this.closeMode === "back" ? "ArrowLeft" : "X";
    const header = html`
      <header class="viewer-header">
        <div class="viewer-title-row">
          <button
            ${this.hints.button({
              id: "close",
              label: this.closeLabel || "Back to files",
              role: "parent",
            })}
            type="button"
            class="viewer-close-button"
            data-action="close-browser-viewer"
            data-close-mode=${this.closeMode}
            aria-label=${this.closeLabel}
            title=${this.closeLabel}
            @click=${this.close}
          >
            ${inlineIcon(closeIcon, this.closeLabel, "viewer-close-icon")}
          </button>
          <div class="viewer-title-block">
            <h2 title=${title}>${title}</h2>
            ${
              subtitle || lineStats
                ? html`<div class="viewer-subtitle-row">
                    ${
                      subtitle
                        ? html`<span class="viewer-subtitle">${subtitle}</span>`
                        : nothing
                    }
                    ${
                      lineCounts
                        ? html`<span
                            class="viewer-line-stats"
                            aria-label=${lineCounts.label}
                          >
                            <span
                              class="is-addition"
                              aria-hidden="true"
                            >${lineCounts.additions}</span>
                            <span
                              class="is-deletion"
                              aria-hidden="true"
                            >${lineCounts.deletions}</span>
                          </span>`
                        : nothing
                    }
                  </div>`
                : nothing
            }
          </div>
          <div class="viewer-actions">
            ${
              this.refreshEventName()
                ? html`<button
                    ${this.hints.button({
                      id: "refresh",
                      label: "Refresh file",
                      role: "refresh",
                    })}
                    type="button"
                    class="viewer-refresh-button"
                    data-action="refresh-viewer"
                    aria-label="Refresh file"
                    title="Refresh file"
                    @click=${this.requestRefresh}
                  >
                    ${inlineIcon(
                      "RefreshCw",
                      "Refresh file",
                      "viewer-refresh-icon",
                    )}
                  </button>`
                : nothing
            }
            ${
              details
                ? html`<button
                    ${this.hints.button({
                      id: "details:open",
                      label: `Show details for ${title}`,
                      role: "details",
                      when: metadata.length > 0,
                    })}
                    type="button"
                    class="viewer-info-button"
                    popovertarget=${this.detailsPopoverId}
                    aria-label="Show details for ${title}"
                    title="Show details"
                  >
                    ${inlineIcon("Info", "Details", "viewer-info-icon")}
                  </button>`
                : nothing
            }
          </div>
        </div>
        ${
          details
            ? html`<div
                ${drawn(this.detailsPopover)}
                ${this.keyboard.popover({
                  id: "details",
                  label: "File details",
                  sessionBound: Boolean(downloadPath),
                  when: metadata.length > 0,
                })}
                id=${this.detailsPopoverId}
                class="viewer-meta-popover"
                popover="auto"
                aria-label="File details"
              >
                <dl>
                  ${metadata.map(
                    (item) => html`<div data-field=${item.field}>
                      <dt>${item.label}</dt>
                      <dd>${item.value}</dd>
                    </div>`,
                  )}
                </dl>
                ${
                  downloadPath
                    ? html`<div class="viewer-meta-actions">
                        <a
                          ${this.hints.link({
                            id: "download",
                            label: "Download",
                            action: ACTION_HINT_ACTION.LINK_OPEN,
                          })}
                          class="viewer-download-link"
                          href=${downloadUrl(downloadPath)}
                          download=${title}
                        >
                          <span class="viewer-download-icon" aria-hidden="true">
                            ${inlineIcon("Download", "", "viewer-download-svg")}
                          </span>
                          <span>Download</span>
                        </a>
                      </div>`
                    : nothing
                }
                <caffold-keyboard-navigation-presentation
                  ${this.keyboard.presentation()}
                ></caffold-keyboard-navigation-presentation>
              </div>`
            : nothing
        }
      </header>
    `;

    switch (state.status) {
      case "loading":
        return html`
          <section class="viewer-panel loading-panel" aria-busy="true">
            ${header}
            <caffold-loading-text
              ?immediate=${state.waited}
            >Loading file...</caffold-loading-text>
          </section>
        `;
      case "error":
        return html`
          <section class="viewer-panel error-panel">
            ${header}
            <p class="surface-message">${state.error.message}</p>
          </section>
        `;
      case "notice": {
        const noticeClass = state.title
          ? "viewer-panel notice-panel"
          : "viewer-panel notice-panel empty-panel";
        return html`
          <section class=${noticeClass}>
            ${state.title ? header : nothing}
            <div
              ${drawn(this.noticeContent)}
              ${this.surfaces.surface({
                id: "notice:scroll",
                label: (name) => `${state.title || name} notice`,
                clipRoots: () => [this, this.noticeContent.value],
              })}
              class="viewer-notice-content"
            >
              <p>${state.message}</p>
              ${
                state.actionLabel && state.action
                  ? html`<button
                      ${this.hints.button({
                        id: `notice:${state.action}`,
                        label: state.actionLabel,
                        role: "notice",
                        when:
                          state.action === "view-source" ||
                          state.action === "view-preview",
                      })}
                      type="button"
                      class="task-secondary-button"
                      data-action=${state.action}
                    >${state.actionLabel}</button>`
                  : nothing
              }
            </div>
          </section>
        `;
      }
      case "diff":
        return html`
          <section class="viewer-panel file-panel diff-panel">
            ${header}
            <caffold-diff-viewer
              ${drawn(this.diffViewer)}
              .diff=${state.diff}
              .position=${state.position}
            ></caffold-diff-viewer>
          </section>
        `;
      case "image": {
        const imageLoading = this.imageDrawn
          ? nothing
          : html`<caffold-loading-text>Loading image...</caffold-loading-text>`;
        return html`
          <section class="viewer-panel image-panel">
            ${header}
            <div
              ${drawn(this.imageStage)}
              ${this.surfaces.surface({
                id: "image:scroll",
                label: (name) => `${state.image.name || name} image`,
                axes: ["vertical", "horizontal"],
                clipRoots: () => [this, this.imageStage.value],
              })}
              class="image-stage"
            >
              <img
                class="image-preview"
                src=${this.imageSource || nothing}
                alt=${state.image.name}
                ?hidden=${!this.imageDrawn}
                @load=${this.showDrawnImage}
                @error=${this.showImageFailure}
              >
              ${imageLoading}
            </div>
          </section>
        `;
      }
      case "document":
        return html`
          <section class="viewer-panel file-panel document-panel">
            ${header}
            ${DOCUMENT_VIEWERS[state.document.kind](
              this.documentFile,
              this.documentViewer,
            )}
          </section>
        `;
      case "markdown":
        return html`
          <section class="viewer-panel file-panel markdown-panel">
            ${header}
            <caffold-markdown-preview
              ${drawn(this.preview)}
            ></caffold-markdown-preview>
          </section>
        `;
      case "file":
        return html`
          <section class="viewer-panel file-panel">
            ${header}
            <caffold-code-viewer
              ${drawn(this.codeViewer)}
              .file=${state.file}
              .position=${state.position}
            ></caffold-code-viewer>
          </section>
        `;
    }
  }

  get status() {
    return this.state.status;
  }

  deactivate() {
    this.cancelRetainedContent();
    this.closeDetailsPopover();
    this.releasePreviewFile();
  }

  setEmpty() {
    this.cancelRetainedContent();
    this.state = { status: "empty" };
    this.show();
  }

  // Shown content stays until the next state arrives; only a wait that
  // outlasts RETAINED_CONTENT_MS turns it into the loading state. Requests made
  // while already waiting keep that wait and its original deadline.
  setLoading(presentation: ViewerPresentation | null = null) {
    if (this.retainedContent) {
      this.retainedContent.presentation = presentation;
      return;
    }
    if (this.state.status === "loading") {
      this.state = { ...this.state, presentation };
      this.show();
      return;
    }
    if (this.state.status !== "empty") {
      const retained: RetainedContent = { presentation, timer: 0 };
      retained.timer = window.setTimeout(
        () => this.finishRetainedContent(retained),
        RETAINED_CONTENT_MS,
      );
      this.retainedContent = retained;
      return;
    }
    this.state = { status: "loading", presentation, waited: false };
    this.show();
  }

  setFile(file: CodeFile & ViewerSource, options: ViewerPositionOptions = {}) {
    this.cancelRetainedContent();
    this.state = {
      status: "file",
      presentation: sourceViewerPresentation(file),
      file,
      position: this.nextPosition(options),
    };
    this.show();
  }

  // `imageRoot` is the Task root that an image address starting with "/"
  // is read from.
  setMarkdown(
    file: ViewerSource & { content: string },
    {
      imageRoot = "",
      ...options
    }: ViewerPositionOptions & { imageRoot?: string } = {},
  ) {
    this.cancelRetainedContent();
    this.state = {
      status: "markdown",
      presentation: sourceViewerPresentation(file),
    };
    this.show();
    this.markdownPreview?.setMarkdown(file.content, {
      ...options,
      images: {
        folder: `${file.path ?? ""}`.split("/").slice(0, -1).join("/"),
        root: imageRoot,
      },
    });
  }

  // `recheck` says the file may have changed since it was fetched.
  setImage(
    image: PreviewImage,
    { recheck = false }: { recheck?: boolean } = {},
  ) {
    this.cancelRetainedContent();
    const held = this.previewFile;
    if (this.state.status !== "image" || this.state.image.path !== image.path) {
      this.imageDrawn = false;
    }
    const metadata = [
      { field: "path", label: "Path", value: image.path },
      image.size === null || image.size === undefined
        ? null
        : { field: "size", label: "Size", value: formatBytes(image.size) },
      image.modifiedMs === null || image.modifiedMs === undefined
        ? null
        : {
            field: "modified",
            label: "Modified",
            value: formatModified(image.modifiedMs) || "Unknown",
          },
      { field: "type", label: "Type", value: image.imageType },
    ].filter((item) => item !== null);
    this.state = {
      status: "image",
      image,
      presentation: { title: image.name, metadata, downloadPath: image.path },
    };
    this.show();
    this.showPreviewFile(imageUrl(image.path));
    this.drawPreviewImage();
    if (recheck && held && this.previewFile === held) {
      this.recheckPreviewFile();
    }
  }

  // `recheck` says the file may have changed since it was fetched.
  setDocument(
    previewDocument: PreviewDocument,
    { recheck = false }: { recheck?: boolean } = {},
  ) {
    this.cancelRetainedContent();
    const held = this.previewFile;
    const previous = this.state;
    this.state = {
      status: "document",
      document: previewDocument,
      presentation: sourceViewerPresentation(previewDocument),
    };
    this.show();
    if (
      previous.status !== "document" ||
      previous.document.kind !== previewDocument.kind
    ) {
      // A new viewer holds nothing yet, so the file is fetched for it.
      this.releasePreviewFile();
    }
    this.showPreviewFile(documentUrl(previewDocument.path));
    if (recheck && held && this.previewFile === held) {
      this.recheckPreviewFile();
    }
  }

  setDiff(
    diff: FileDiff & ViewerDiff,
    options: ViewerPositionOptions & { presentation?: ViewerPresentation } = {},
  ) {
    this.cancelRetainedContent();
    const { presentation = diffViewerPresentation(diff), ...viewerOptions } =
      options;
    this.state = {
      status: "diff",
      presentation,
      diff,
      position: this.nextPosition(viewerOptions),
    };
    this.show();
  }

  setNotice(
    message: string,
    options: { actionLabel?: string; action?: string; title?: string } = {},
  ) {
    this.cancelRetainedContent();
    this.state = {
      status: "notice",
      message,
      actionLabel: options.actionLabel ?? "",
      action: options.action ?? "",
      title: options.title ?? "",
    };
    this.show();
  }

  setError(presentation: ViewerPresentation | null, error: Error) {
    this.cancelRetainedContent();
    this.state = { status: "error", presentation, error };
    this.show();
  }

  captureContentScroll(): ScrollPosition | null {
    const viewer = this.codeViewer.value ?? this.diffViewer.value;
    if (viewer) {
      return viewer.getScrollState();
    }
    return this.preview.value?.getScrollState() ?? null;
  }

  visibleLine() {
    const viewer = this.codeViewer.value ?? this.diffViewer.value;
    return viewer?.visibleLine() ?? null;
  }

  scrollToLine(line: number | string | null | undefined) {
    const viewer = this.codeViewer.value ?? this.diffViewer.value;
    return viewer?.scrollToLine(line) ?? false;
  }

  setCloseLabel(label: string) {
    this.closeLabel = label;
  }

  setCloseMode(mode: string) {
    this.closeMode = mode === "back" ? "back" : "close";
  }

  // `actions` names what each control does: Back or close (`parent`),
  // `details`, `refresh`, and a `notice` button here, and a preview's `link`
  // and `button`. Only the child the state draws has a ref.
  actionHintScope(pull: ActionHintPull = {}) {
    const own = this.hints.scope(pull);
    const clipRoots = [this, ...(pull.clipRoots ?? [])];
    return mergeActionHintScopes(
      own,
      this.documentViewer.value?.actionHintScope?.({
        ...pull,
        scopeId: `${pull.scopeId}:document`,
        clipRoots,
      }),
      this.preview.value?.actionHintScope({
        ...pull,
        scopeId: `${pull.scopeId}:preview`,
        clipRoots,
      }),
    );
  }

  scrollSurfaceScope({ label = "File", ...pull }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, label });
    const state = this.state;
    const title =
      ("presentation" in state && state.presentation?.title) || label;
    const child = (kind: string, childLabel: string) => ({
      ...pull,
      scopeId: `${pull.scopeId}:${kind}`,
      label: childLabel,
      clipRoots: [this, ...(pull.clipRoots ?? [])],
    });
    return mergeScrollSurfaceScopes(
      own,
      this.codeViewer.value?.scrollSurfaceScope(
        child("source", `${title} source`),
      ),
      this.diffViewer.value?.scrollSurfaceScope(child("diff", `${title} diff`)),
      this.preview.value?.scrollSurfaceScope(
        child("preview", `${title} preview`),
      ),
      state.status === "document"
        ? this.documentViewer.value?.scrollSurfaceScope(
            child(state.document.kind, `${title} preview`),
          )
        : null,
    );
  }

  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  // Every new state closes the details popover, and only a preview keeps the
  // file it fetched.
  private show() {
    this.closeDetailsPopover();
    if (this.state.status !== "image" && this.state.status !== "document") {
      this.releasePreviewFile();
    }
  }

  // A file kept in place keeps where it is read; any other opens at its line
  // or its top.
  private nextPosition(options: ViewerPositionOptions): ViewerPosition {
    return {
      scroll: options.preserveScroll ? this.captureContentScroll() : null,
      line: options.line,
    };
  }

  private finishRetainedContent(retained: RetainedContent) {
    if (this.retainedContent !== retained) {
      return;
    }
    this.retainedContent = null;
    this.state = {
      status: "loading",
      presentation: retained.presentation,
      waited: true,
    };
    this.show();
  }

  private cancelRetainedContent() {
    if (!this.retainedContent) {
      return;
    }
    window.clearTimeout(this.retainedContent.timer);
    this.retainedContent = null;
  }

  private closeDetailsPopover() {
    const popover = this.detailsPopover.value;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // A parent transition may already have detached the viewer.
    }
  }

  private close() {
    this.dispatchEvent(
      new CustomEvent("caffold:close-file-viewer", { bubbles: true }),
    );
  }

  private requestRefresh() {
    const eventName = this.refreshEventName();
    if (eventName) {
      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
    }
  }

  private refreshEventName() {
    const action = this.getAttribute("refresh-action");
    return action ? `caffold:${action}` : "";
  }

  // A picture let go of for another file's may still finish loading.
  private showDrawnImage(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    if (image.src === this.previewFile?.objectUrl) {
      this.imageDrawn = true;
    }
  }

  private showImageFailure() {
    if (this.state.status !== "image") {
      return;
    }
    this.setError(
      sourceViewerPresentation(this.state.image),
      new Error("Image preview failed to load."),
    );
  }

  // Fetches the preview's file unless it is the one already drawn or
  // arriving; a file whose first fetch failed is fetched again.
  private showPreviewFile(url: string) {
    const shown = this.previewFile;
    if (shown?.url === url && shown.phase !== PREVIEW_PHASE.FAILED) {
      return;
    }
    this.releasePreviewFile();
    const preview: PreviewFile = {
      url,
      phase: PREVIEW_PHASE.READING,
      fetching: null,
      file: null,
      version: null,
      objectUrl: "",
      recheckAfter: false,
    };
    this.previewFile = preview;
    this.fetchPreviewFile(preview);
  }

  private recheckPreviewFile() {
    if (this.previewFile) {
      this.movePreviewFile(this.previewFile, { event: PREVIEW_EVENT.RECHECK });
    }
  }

  private releasePreviewFile() {
    const preview = this.previewFile;
    if (!preview) {
      return;
    }
    this.previewFile = null;
    this.imageSource = "";
    this.documentFile = null;
    preview.fetching?.abort();
    if (preview.objectUrl) {
      URL.revokeObjectURL(preview.objectUrl);
    }
  }

  // The one place a preview file changes phase.
  private movePreviewFile(preview: PreviewFile, move: PreviewMove) {
    const previous = preview.phase;
    const next = PREVIEW_EDGES[previous][move.event];
    if (!next) {
      return;
    }
    preview.phase = next;
    switch (move.event) {
      case PREVIEW_EVENT.RECHECK:
        if (previous === PREVIEW_PHASE.SHOWN) {
          this.fetchPreviewFile(preview);
        } else {
          preview.recheckAfter = true;
        }
        return;
      case PREVIEW_EVENT.READ:
        preview.fetching = null;
        if (
          previous === PREVIEW_PHASE.READING ||
          move.answer.version === null ||
          move.answer.version !== preview.version
        ) {
          this.keepPreviewCopy(preview, move.answer, {
            newerCopy: previous === PREVIEW_PHASE.RECHECKING,
          });
        }
        if (preview.recheckAfter) {
          preview.recheckAfter = false;
          this.movePreviewFile(preview, { event: PREVIEW_EVENT.RECHECK });
        }
        return;
      case PREVIEW_EVENT.FAILED:
        preview.fetching = null;
        preview.recheckAfter = false;
        if (previous === PREVIEW_PHASE.READING) {
          this.showImageFailure();
        }
        return;
    }
  }

  // A document viewer is handed the first fetch itself, so it says the file
  // is loading until it arrives and reports a failed fetch the way it reports
  // a document it cannot open.
  private fetchPreviewFile(preview: PreviewFile) {
    const fetching = new AbortController();
    preview.fetching = fetching;
    const reading = fetchInChunks(preview.url, { signal: fetching.signal });
    if (
      preview.phase === PREVIEW_PHASE.READING &&
      this.state.status === "document"
    ) {
      this.documentFile = {
        file: reading.then(({ file }) => file),
        newerCopy: false,
      };
    }
    const current = () =>
      this.previewFile === preview && preview.fetching === fetching;
    reading.then(
      (answer) => {
        if (current()) {
          this.movePreviewFile(preview, { event: PREVIEW_EVENT.READ, answer });
        }
      },
      (error) => {
        if (current() && error?.name !== "AbortError") {
          this.movePreviewFile(preview, { event: PREVIEW_EVENT.FAILED });
        }
      },
    );
  }

  private keepPreviewCopy(
    preview: PreviewFile,
    { file, version }: FetchedFile,
    { newerCopy }: { newerCopy: boolean },
  ) {
    preview.file = file;
    preview.version = version;
    if (preview.objectUrl) {
      URL.revokeObjectURL(preview.objectUrl);
      preview.objectUrl = "";
    }
    if (this.state.status === "image") {
      this.drawPreviewImage();
    } else if (newerCopy && this.state.status === "document") {
      this.documentFile = { file, newerCopy: true };
    }
  }

  // A picture shown anew takes the copy already fetched.
  private drawPreviewImage() {
    const preview = this.previewFile;
    if (!preview?.file) {
      return;
    }
    preview.objectUrl ||= URL.createObjectURL(preview.file);
    this.imageSource = preview.objectUrl;
  }

  // The preview is drawn the first time it is needed, which is right after
  // the viewer switches to it.
  private get markdownPreview() {
    this.performUpdate();
    return this.preview.value;
  }
}

await compactIconButton.register(
  "caffold-review-file-viewer",
  "> .viewer-panel > .viewer-header > .viewer-title-row > .viewer-actions > .viewer-refresh-button",
);

await compactIconButton.register(
  "caffold-review-file-viewer",
  "> .viewer-panel > .viewer-header > .viewer-title-row > .viewer-close-button",
);

customElements.define("caffold-review-file-viewer", CaffoldReviewFileViewer);
