import { html, LitElement, nothing, type TemplateResult } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  type ActionHintTarget,
  buttonActionHintTarget,
  emptyActionHintScope,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../action-hints.js";
import { documentUrl, downloadUrl, imageUrl } from "../api.ts";
import { type FetchedFile, fetchInChunks } from "../chunked-fetch.ts";
import { compactIconButton } from "../component-styles.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../keyboard-navigation.js";
import "../keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "../keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollAxis,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "../scroll-scope.js";
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

// How long switching to another file keeps showing the previous one before
// the loading state replaces it.
const RETAINED_CONTENT_MS = 180;

// A document preview hands its file to the viewer of its kind.
const DOCUMENT_VIEWERS: Record<
  DocumentPreviewKind,
  {
    tagName: string;
    element: (file: DocumentPreviewFile | null) => TemplateResult;
  }
> = {
  pdf: {
    tagName: "caffold-pdf-viewer",
    element: (file) =>
      html`<caffold-pdf-viewer .file=${file}></caffold-pdf-viewer>`,
  },
  docx: {
    tagName: "caffold-docx-viewer",
    element: (file) =>
      html`<caffold-docx-viewer .file=${file}></caffold-docx-viewer>`,
  },
  pptx: {
    tagName: "caffold-pptx-viewer",
    element: (file) =>
      html`<caffold-pptx-viewer .file=${file}></caffold-pptx-viewer>`,
  },
  xlsx: {
    tagName: "caffold-xlsx-viewer",
    element: (file) =>
      html`<caffold-xlsx-viewer .file=${file}></caffold-xlsx-viewer>`,
  },
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
  scrollSurfaceScope(options: ScrollSurfaceScopeOptions): ScrollSurfaceScope;
  actionHintScope?(
    options: ActionHintScopeOptions & {
      linkActionId?: string;
      buttonActionId?: string;
      isCurrent?: () => boolean;
    },
  ): ActionHintScope;
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
      if (event.target === this.detailsPopover()) {
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
            <div class="viewer-notice-content">
              <p>${state.message}</p>
              ${
                state.actionLabel && state.action
                  ? html`<button
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
            <div class="image-stage">
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
            ${DOCUMENT_VIEWERS[state.document.kind].element(this.documentFile)}
          </section>
        `;
      case "markdown":
        return html`
          <section class="viewer-panel file-panel markdown-panel">
            ${header}
            <caffold-markdown-preview></caffold-markdown-preview>
          </section>
        `;
      case "file":
        return html`
          <section class="viewer-panel file-panel">
            ${header}
            <caffold-code-viewer
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
    const viewer = this.querySelector<CaffoldCodeViewer | CaffoldDiffViewer>(
      "caffold-code-viewer, caffold-diff-viewer",
    );
    if (viewer) {
      return viewer.getScrollState();
    }
    return (
      this.querySelector<CaffoldMarkdownPreview>(
        "caffold-markdown-preview",
      )?.getScrollState() ?? null
    );
  }

  visibleLine() {
    const viewer = this.querySelector<CaffoldCodeViewer | CaffoldDiffViewer>(
      "caffold-code-viewer, caffold-diff-viewer",
    );
    return viewer?.visibleLine() ?? null;
  }

  scrollToLine(line: number | string | null | undefined) {
    const viewer = this.querySelector<CaffoldCodeViewer | CaffoldDiffViewer>(
      "caffold-code-viewer, caffold-diff-viewer",
    );
    return viewer?.scrollToLine(line) ?? false;
  }

  setCloseLabel(label: string) {
    this.closeLabel = label;
  }

  setCloseMode(mode: string) {
    this.closeMode = mode === "back" ? "back" : "close";
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    noticeActionId = "",
    detailsActionId = "",
    refreshActionId = "",
    linkActionId = "",
    buttonActionId = "",
    clipRoots = [],
  }: ActionHintScopeOptions & {
    noticeActionId?: string;
    detailsActionId?: string;
    refreshActionId?: string;
    linkActionId?: string;
    buttonActionId?: string;
  } = {}): ActionHintScope {
    const closeSelector =
      ':scope > .viewer-panel > .viewer-header > .viewer-title-row > button.viewer-close-button[data-action="close-browser-viewer"]';
    const control = this.querySelector<HTMLButtonElement>(closeSelector);
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const targets: ActionHintTarget[] = [];
    const detailsSelector =
      ":scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-info-button";
    const detailsControl = detailsActionId
      ? this.querySelector<HTMLButtonElement>(detailsSelector)
      : null;
    const detailsPopover = detailsActionId ? this.detailsPopover() : null;
    if (
      detailsActionId &&
      detailsControl &&
      detailsPopover &&
      this.hasDetailsMetadata(detailsPopover) &&
      !detailsControl.disabled
    ) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:details:open`,
          actionId: detailsActionId,
          label:
            detailsControl.getAttribute("aria-label") || "Show file details",
          control: detailsControl,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(detailsSelector) === detailsControl &&
            this.detailsPopover() === detailsPopover &&
            detailsControl.getAttribute("popovertarget") ===
              detailsPopover.id &&
            this.hasDetailsMetadata(detailsPopover) &&
            !detailsControl.disabled &&
            !detailsPopover.matches(":popover-open"),
        }),
      );
    }
    if (actionId && control && !control.disabled) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:close`,
          actionId,
          label:
            control.getAttribute("aria-label") ||
            this.closeLabel ||
            "Back to files",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(closeSelector) === control &&
            !control.disabled,
        }),
      );
    }
    const refreshSelector =
      ':scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-refresh-button[data-action="refresh-viewer"]';
    const refreshControl = refreshActionId
      ? this.querySelector<HTMLButtonElement>(refreshSelector)
      : null;
    if (refreshControl && !refreshControl.disabled) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:refresh`,
          actionId: refreshActionId,
          label: refreshControl.getAttribute("aria-label") || "Refresh file",
          control: refreshControl,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(refreshSelector) === refreshControl &&
            !refreshControl.disabled,
        }),
      );
    }
    const noticeControl = noticeActionId
      ? this.querySelector<HTMLButtonElement>(
          ':scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="view-source"], :scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="view-preview"]',
        )
      : null;
    const noticeAction = `${noticeControl?.dataset.action ?? ""}`;
    if (
      noticeControl &&
      !noticeControl.disabled &&
      ["view-source", "view-preview"].includes(noticeAction)
    ) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:notice:${noticeAction}`,
          actionId: noticeActionId,
          label:
            noticeControl.getAttribute("aria-label") ||
            noticeControl.textContent?.trim() ||
            (noticeAction === "view-preview" ? "View preview" : "View source"),
          control: noticeControl,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(
              `:scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="${noticeAction}"]`,
            ) === noticeControl &&
            !noticeControl.disabled,
        }),
      );
    }
    const ownScope: ActionHintScope = {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
    const state = this.state;
    if (state.status === "document") {
      return mergeActionHintScopes(
        ownScope,
        this.documentActionHintScope(state, {
          scopeId,
          linkActionId,
          buttonActionId,
          clipRoots,
        }),
      );
    }
    if (state.status !== "markdown") {
      return ownScope;
    }
    const preview = this.querySelector<CaffoldMarkdownPreview>(
      ":scope > .markdown-panel > caffold-markdown-preview",
    );
    return mergeActionHintScopes(
      ownScope,
      preview?.actionHintScope({
        scopeId: `${scopeId}:preview`,
        linkActionId,
        clipRoots: [this, ...clipRoots],
        isCurrent: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(
            ":scope > .markdown-panel > caffold-markdown-preview",
          ) === preview,
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "File",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const state = this.state;
    if (!scopeId || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const childOptions = (kind: string, childLabel: string) => ({
      scopeId: `${scopeId}:${kind}`,
      label: childLabel,
      clipRoots: [this, ...clipRoots],
      isCurrent: () => this.isConnected && !this.hidden && this.state === state,
    });
    if (state.status === "file") {
      return (
        this.querySelector<CaffoldCodeViewer>(
          ":scope > .file-panel > caffold-code-viewer",
        )?.scrollSurfaceScope(
          childOptions("source", `${state.presentation.title || label} source`),
        ) ?? emptyScrollSurfaceScope()
      );
    }
    if (state.status === "diff") {
      return (
        this.querySelector<CaffoldDiffViewer>(
          ":scope > .diff-panel > caffold-diff-viewer",
        )?.scrollSurfaceScope(
          childOptions("diff", `${state.presentation.title || label} diff`),
        ) ?? emptyScrollSurfaceScope()
      );
    }
    if (state.status === "markdown") {
      return (
        this.querySelector<CaffoldMarkdownPreview>(
          ":scope > .markdown-panel > caffold-markdown-preview",
        )?.scrollSurfaceScope(
          childOptions(
            "preview",
            `${state.presentation.title || label} preview`,
          ),
        ) ?? emptyScrollSurfaceScope()
      );
    }
    if (state.status === "document") {
      const { kind } = state.document;
      return (
        this.querySelector<DocumentViewer>(
          `:scope > .document-panel > ${DOCUMENT_VIEWERS[kind].tagName}`,
        )?.scrollSurfaceScope(
          childOptions(kind, `${state.presentation.title || label} preview`),
        ) ?? emptyScrollSurfaceScope()
      );
    }
    if (state.status === "image") {
      return this.ownScrollSurfaceScope({
        scopeId: `${scopeId}:image`,
        label: `${state.image.name || label} image`,
        state,
        currentScrollport: () =>
          this.querySelector(":scope > .image-panel > .image-stage"),
        axes: ["vertical", "horizontal"],
        clipRoots,
      });
    }
    if (state.status === "notice") {
      return this.ownScrollSurfaceScope({
        scopeId: `${scopeId}:notice`,
        label: `${state.title || label} notice`,
        state,
        currentScrollport: () =>
          this.querySelector(":scope > .notice-panel > .viewer-notice-content"),
        clipRoots,
      });
    }
    return emptyScrollSurfaceScope();
  }

  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    const popover = this.detailsPopover();
    const presentation =
      popover?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (
      !scopeId ||
      this.hidden ||
      !popover ||
      !this.hasDetailsMetadata(popover) ||
      !dialog ||
      !hud ||
      !selector
    ) {
      return [];
    }
    const contextId = `${scopeId}:details`;
    const isCurrent = () =>
      this.isConnected &&
      !this.hidden &&
      this.detailsPopover() === popover &&
      this.hasDetailsMetadata(popover);
    const download = this.downloadLink(popover);
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: download
            ? {
                blocked: false,
                targets: [
                  linkActionHintTarget({
                    invalidationOwner: this,
                    id: `${contextId}:download`,
                    actionId: ACTION_HINT_ACTION.LINK_OPEN,
                    label: (download.textContent ?? "").trim(),
                    control: download,
                    clipRoots: [popover],
                    isActionable: () =>
                      isCurrent() && this.downloadLink(popover) === download,
                  }),
                ],
                mutationRoots: [popover],
                scrollRoots: [popover],
              }
            : emptyActionHintScope(),
          sessionBound: Boolean(download),
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "File details",
            popover,
            isCurrent,
          }),
        },
      }),
    ];
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
    const popover = this.detailsPopover();
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // A parent transition may already have detached the viewer.
    }
  }

  // Links and controls inside a drawn document belong to the viewer of its
  // kind; a viewer with nothing to press publishes no scope.
  private documentActionHintScope(
    state: Extract<ViewerState, { status: "document" }>,
    {
      scopeId,
      linkActionId,
      buttonActionId,
      clipRoots,
    }: {
      scopeId: string;
      linkActionId: string;
      buttonActionId: string;
      clipRoots: Element[];
    },
  ) {
    const { tagName } = DOCUMENT_VIEWERS[state.document.kind];
    const selector = `:scope > .document-panel > ${tagName}`;
    const viewer = this.querySelector<DocumentViewer>(selector);
    return (
      viewer?.actionHintScope?.({
        scopeId: `${scopeId}:document`,
        linkActionId,
        buttonActionId,
        clipRoots: [this, ...clipRoots],
        isCurrent: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(selector) === viewer,
      }) ?? emptyActionHintScope()
    );
  }

  private ownScrollSurfaceScope({
    scopeId,
    label,
    state,
    currentScrollport,
    axes,
    clipRoots = [],
  }: {
    scopeId: string;
    label: string;
    state: ViewerState;
    currentScrollport: () => Element | null;
    axes?: ScrollAxis[];
    clipRoots?: Element[];
  }): ScrollSurfaceScope {
    const scrollport = currentScrollport();
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          ...(axes ? { axes } : {}),
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.state === state &&
            currentScrollport() === scrollport &&
            scrollport.isConnected &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this, scrollport],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
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
    return this.querySelector<CaffoldMarkdownPreview>(
      ":scope > .markdown-panel > caffold-markdown-preview",
    );
  }

  private detailsPopover() {
    return this.querySelector<HTMLElement>(
      `:scope > .viewer-panel > .viewer-header > #${this.detailsPopoverId}`,
    );
  }

  private hasDetailsMetadata(popover: Element) {
    return Boolean(popover.querySelector(":scope > dl > div"));
  }

  private downloadLink(popover: Element) {
    return popover.querySelector<HTMLAnchorElement>(
      ":scope > .viewer-meta-actions > .viewer-download-link",
    );
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
