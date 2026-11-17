import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import {
  checkLanguageServerRepository,
  findLanguageServerPlaces,
  getLanguageServerRepository,
  type LanguageServerPlace,
  type LanguageServerRepository,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import { subscribeToWatch, watchChangeAffectsPath } from "#app/watch.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-navigator.js";
import type { CaffoldFileNavigator } from "#components/file-navigator.js";
import "#components/segmented-control.js";
import type { CaffoldSegmentedControl } from "#components/segmented-control.js";
import { cleanLogicalPath } from "#tasks/task-format.js";
import { taskThreadId } from "#tasks/task-list-model.js";
import "./components/branch-changes.js";
import type { CaffoldReviewBranchChanges } from "./components/branch-changes.js";
import "./components/places.js";
import {
  type CaffoldReviewPlaces,
  type ReviewPlace,
  type ReviewPlaceOpenDetail,
  type ReviewPlacesSnapshot,
  reviewFindTitle,
} from "./components/places.js";
import "./components/selected-file.js";
import type {
  ReviewChanges,
  ReviewView,
} from "./components/selected-file/content.js";
import type { CaffoldReviewSelectedFile } from "./components/selected-file.js";
import "./components/working-tree-changes.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { ParsedRoute } from "#app/navigation-routes.js";
import type {
  FileNavigatorOpenFileDetail,
  FileNavigatorRefreshSelectedDetail,
} from "#components/file-navigator.js";
import type {
  AdjacentFile,
  CodeNameIntentDetail,
  FileViewerOpenAdjacentDetail,
} from "#components/file-viewer.js";
import type { OpenCompareDiffDetail } from "#components/git-compare-tree.js";
import type { SegmentedControlIntentDetail } from "#components/segmented-control.js";
import "#components/split-view.js";
import type { CaffoldSplitView } from "#components/split-view.js";
import type { ReviewBaseIntentDetail } from "./components/branch-changes.js";
import type { ReviewRepresentationIntentDetail } from "./components/selected-file.js";
import type { OpenGitDiffDetail } from "./components/working-tree-changes/components/changes-tree.js";
import type { CaffoldReviewWorkingTreeChanges } from "./components/working-tree-changes.js";
import {
  codeNamesFor,
  languageServersGettingReady,
} from "./layout/code-names.js";
import {
  joinLogicalPath,
  type ReviewTask,
  relativeTaskPath,
  reviewPathFor,
  taskRootPath,
  taskWorktreeRootPath,
} from "./layout/paths.js";
import {
  normalizeForTask,
  normalizeReviewRoute,
  type ReviewFind,
  type ReviewRoute,
  type ReviewRouteInput,
  reviewContextKey,
  reviewFindAt,
  reviewRouteKey,
  routeForSelectedFile,
  taskRouteForReview,
  viewerStateKey,
} from "./layout/route.js";
import {
  fileHasRepresentation,
  isFileRepresentation,
  isReviewViewer,
  type ReviewViewer,
} from "./representations.js";

import styles from "./layout.css.js";

export { isReviewViewer } from "./representations.js";

export interface TaskReviewRouteIntentDetail {
  route: ParsedRoute;
}

type ReviewChangesElement =
  | CaffoldReviewWorkingTreeChanges
  | CaffoldReviewBranchChanges;

export interface ChangesRead {
  ok: boolean;
  error?: unknown;
  hadData?: boolean;
  wasOutdated?: boolean;
  background?: boolean;
}

interface SyncOptions {
  contextChanged?: boolean;
  routeChanged?: boolean;
  scopeChanged?: boolean;
  revealFileSelection?: boolean;
  reactivated?: boolean;
  findClosed?: boolean;
}

// The places read for the find the route names, under the find's key.
type PlacesRead = { key: string; name: string } & (
  | { status: "loading" }
  | { status: "ready"; places: ReviewPlace[] }
  | { status: "failed"; message: string }
);

// How often Review reads its repository's language servers again while one
// gets ready.
const LANGUAGE_SERVERS_READ_AGAIN_MS = 1000;

@customElement("caffold-task-review")
export class CaffoldTaskReview extends CaffoldElement {
  @state()
  private accessor route: ReviewRoute = normalizeReviewRoute();
  @state()
  private accessor errorMessage = "";
  @state()
  private accessor placesRead: PlacesRead | null = null;

  static override styles = styles;

  private active = false;
  private task: ReviewTask | null = null;
  private contextKey = "";
  private previousRouteKey = "";
  private watchUnsubscribe: (() => void) | null = null;
  private watchPath = "";
  private pendingWatchViewerRefresh = false;
  private readonly navigatorScroll = new Map<
    string,
    { top: number; left: number }
  >();
  private liveUpdates: unknown = null;
  // The repository language servers of the Task's root, as last read; null
  // until a read answers, and when it fails.
  private languageServers: LanguageServerRepository | null = null;
  private languageServersPath = "";
  private languageServersKnown = false;
  private languageServersRead = 0;
  private languageServersReading: AbortController | null = null;
  private languageServersTimer: ReturnType<typeof setTimeout> | null = null;
  private placesReading: AbortController | null = null;
  private codeNameAsking: AbortController | null = null;
  private readonly navigatorPane = new DrawnRef<HTMLElement>(this);
  private readonly viewerPane = new DrawnRef<HTMLElement>(this);
  private readonly navigatorAxis = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly viewerAxis = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly workingList = new DrawnRef<CaffoldReviewWorkingTreeChanges>(
    this,
  );
  private readonly branchList = new DrawnRef<CaffoldReviewBranchChanges>(this);
  private readonly filesList = new DrawnRef<CaffoldFileNavigator>(this);
  private readonly splitView = new DrawnRef<CaffoldSplitView>(this);
  private readonly fileViewer = new DrawnRef<CaffoldReviewSelectedFile>(this);
  private readonly placesList = new DrawnRef<CaffoldReviewPlaces>(this);
  private readonly languageServersChanged = () => {
    void this.readLanguageServers();
  };

  override connectedCallback() {
    super.connectedCallback();
    this.active = true;
    window.addEventListener(
      "caffold:language-servers-changed",
      this.languageServersChanged,
    );
    this.markChangesOutdated();
    this.syncReview({ reactivated: true });
    this.performUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.active = false;
    window.removeEventListener(
      "caffold:language-servers-changed",
      this.languageServersChanged,
    );
    this.stopLanguageServers();
    this.codeNameAsking?.abort();
    this.codeNameAsking = null;
    this.placesReading?.abort();
    this.placesReading = null;
    this.unsubscribeWatch();
    this.fileNavigator.setWatchActive(false);
  }

  override render() {
    const route = this.route;
    const findShown = Boolean(route.find);
    const changesShown = !findShown && route.navigator === "changes";
    return html`
      <section class="task-review-workspace" aria-label="Task review">
        <div class="task-review-notices">
          <p
            class="task-review-error"
            role="alert"
            ?hidden=${!this.errorMessage}
          >${this.errorMessage}</p>
        </div>
        <caffold-split-view
          ${drawn(this.splitView)}
          class="task-review-layout"
          storage-key="caffold:pane-width:task-review"
          collapsed-storage-key="caffold:pane-collapsed:task-review"
          resizer-label="Resize review navigator"
          pane-label="review navigator"
          start-min="220"
          end-min="360"
        >
          <aside
            ${drawn(this.navigatorPane)}
            slot="list"
            class="task-review-navigator-pane"
            aria-label="Review navigator"
          >
            <div
              class="task-review-pane-axis task-review-navigator-axis"
              ?hidden=${findShown}
            >
              <caffold-segmented-control
                ${drawn(this.navigatorAxis)}
                data-review-axis="navigator"
                @caffold:segmented-control-intent=${this.chooseAxis}
              ></caffold-segmented-control>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="working"
              ?hidden=${!changesShown || route.scope !== "working"}
            >
              <caffold-review-working-tree-changes
                ${drawn(this.workingList)}
                @caffold:review-branch-intent=${this.reviewBranch}
                @caffold:review-changes-read=${this.followChangesRead}
                @caffold:open-git-diff=${this.openChange}
              ></caffold-review-working-tree-changes>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="branch"
              ?hidden=${!changesShown || route.scope !== "branch"}
            >
              <caffold-review-branch-changes
                ${drawn(this.branchList)}
                @caffold:review-base-intent=${this.chooseBase}
                @caffold:review-changes-read=${this.followChangesRead}
                @caffold:open-compare-diff=${this.openChange}
              ></caffold-review-branch-changes>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="files"
              ?hidden=${findShown || route.navigator !== "files"}
            >
              <caffold-file-navigator
                ${drawn(this.filesList)}
                @caffold:file-navigator-open-file=${this.openChange}
                @caffold:file-navigator-refresh-selected=${this.refreshFile}
              ></caffold-file-navigator>
            </div>
            <caffold-review-places
              ${drawn(this.placesList)}
              class="task-review-navigator"
              ?hidden=${!findShown}
              .snapshot=${this.placesSnapshot()}
              @caffold:review-place-open=${this.openPlace}
              @caffold:review-places-close=${this.closePlaces}
            ></caffold-review-places>
          </aside>
          <section
            ${drawn(this.viewerPane)}
            slot="detail"
            class="task-review-viewer-pane"
            aria-label="Review file"
          >
            <div
              class="task-review-viewer-empty-header"
              aria-hidden="true"
            ></div>
            <div class="task-review-pane-axis task-review-viewer-axis">
              <caffold-segmented-control
                ${drawn(this.viewerAxis)}
                data-review-axis="viewer"
                @caffold:segmented-control-intent=${this.chooseAxis}
              ></caffold-segmented-control>
            </div>
            <caffold-review-selected-file
              ${drawn(this.fileViewer)}
              @caffold:review-representation-intent=${this.chooseRepresentation}
              @caffold:close-file-viewer=${this.closeFile}
              @caffold:file-viewer-open-adjacent=${this.openChange}
              @caffold:code-name-intent=${this.answerCodeName}
            ></caffold-review-selected-file>
          </section>
        </caffold-split-view>
      </section>
    `;
  }

  override firstUpdated() {
    this.fileNavigator.setStorageKey(null);
    this.fileNavigator.setLiveUpdates(this.liveUpdates);
    this.fileNavigator.setWatchActive(false);
    this.fileNavigator.setRefreshVisible(false);
  }

  setLiveUpdates(liveUpdates: unknown) {
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    const path = this.watchPath;
    this.unsubscribeWatch();
    this.liveUpdates = liveUpdates ?? null;
    this.fileNavigator.setLiveUpdates(this.liveUpdates);
    if (this.active && path) {
      this.subscribeWatch(path);
    }
  }

  setDetailContext({
    identity = null,
    path = "",
    repository = null,
    route = null,
  }: {
    identity?: { id?: string | null; kind?: string | null } | null;
    path?: string;
    repository?: { rootPath?: string; branch?: string | null } | null;
    route?: ReviewRouteInput | null;
  } = {}) {
    const id = `${identity?.id ?? ""}`;
    const contextPath =
      cleanLogicalPath(path || repository?.rootPath || "") || ".";
    const repositoryRootPath = repository
      ? cleanLogicalPath(repository.rootPath || path || "") || "."
      : "";
    const changed = this.setTaskContext(
      id
        ? {
            threadId:
              identity?.kind === "task"
                ? id
                : `${identity?.kind ?? "detail"}:${id}`,
            cwdPath: contextPath,
            ...(repository
              ? { worktree: { ...repository, rootPath: repositoryRootPath } }
              : {}),
          }
        : null,
      route,
    );
    this.performUpdate();
    return changed;
  }

  currentTaskRoute() {
    const threadId = taskThreadId(this.task);
    if (!threadId) {
      return null;
    }
    return taskRouteForReview(threadId, this.route);
  }

  actionHintScope() {
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyActionHintScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane: Element | null = this.navigatorPane.value ?? null;
    const viewerPane: Element | null = this.viewerPane.value ?? null;
    const navigatorActive =
      this.split.listShown() && hasActionHintLayoutBox(navigatorPane);
    const viewerActive =
      this.split.detailShown() && hasActionHintLayoutBox(viewerPane);
    const navigatorClipRoots = [this, navigatorPane].filter(
      (root): root is Element => root !== null,
    );
    const viewerClipRoots = [this, viewerPane].filter(
      (root): root is Element => root !== null,
    );
    const find = this.route.find;
    const navigatorAxis =
      navigatorActive && !find
        ? this.axisControl("navigator").actionHintScope({
            scopeId: `${scopeId}:navigator-axis`,
            actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
            clipRoots: navigatorClipRoots,
          })
        : null;
    const viewerAxis = viewerActive
      ? this.axisControl("viewer").actionHintScope({
          scopeId: `${scopeId}:viewer-axis`,
          actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          clipRoots: viewerClipRoots,
        })
      : null;
    const navigatorScope = !navigatorActive
      ? null
      : find
        ? this.places.actionHintScope({
            scopeId: `${scopeId}:places`,
            actions: {
              place: ACTION_HINT_ACTION.FILE_OPEN,
              close: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            },
            clipRoots: navigatorClipRoots,
          })
        : this.route.navigator === "files"
          ? this.fileNavigator.actionHintScope({
              scopeId: `${scopeId}:files`,
              actions: {
                file: ACTION_HINT_ACTION.FILE_OPEN,
                disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              },
              clipRoots: navigatorClipRoots,
            })
          : this.route.scope === "branch"
            ? this.branchChanges.actionHintScope({
                scopeId: `${scopeId}:branch`,
                actions: {
                  file: ACTION_HINT_ACTION.FILE_OPEN,
                  disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                  select: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
                },
                clipRoots: navigatorClipRoots,
              })
            : this.workingTreeChanges.actionHintScope({
                scopeId: `${scopeId}:working`,
                actions: {
                  file: ACTION_HINT_ACTION.FILE_OPEN,
                  disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                  branch: ACTION_HINT_ACTION.REVIEW_AXIS,
                },
                clipRoots: navigatorClipRoots,
              });
    const viewerScope =
      viewerActive && this.route.path
        ? this.selectedFile.actionHintScope({
            scopeId: `${scopeId}:viewer`,
            actions: {
              parent: ACTION_HINT_ACTION.PARENT,
              notice: ACTION_HINT_ACTION.REVIEW_AXIS,
              details: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
              refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              link: ACTION_HINT_ACTION.LINK_OPEN,
              button: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            },
            clipRoots: viewerClipRoots,
          })
        : null;
    const resizerScope = this.split.actionHintScope({
      scopeId: `${scopeId}:navigator`,
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this],
    });
    return mergeActionHintScopes(
      navigatorAxis,
      viewerAxis,
      navigatorScope,
      resizerScope,
      viewerScope,
    );
  }

  scrollSurfaceScope() {
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyScrollSurfaceScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane: Element | null = this.navigatorPane.value ?? null;
    const viewerPane: Element | null = this.viewerPane.value ?? null;
    const navigatorClipRoots = [this, navigatorPane].filter(
      (root): root is Element => root !== null,
    );
    const viewerClipRoots = [this, viewerPane].filter(
      (root): root is Element => root !== null,
    );
    const find = this.route.find;
    const navigatorScope = !(
      this.split.listShown() && hasScrollLayoutBox(navigatorPane)
    )
      ? null
      : find
        ? this.places.scrollSurfaceScope({
            scopeId: `${scopeId}:places`,
            label: reviewFindTitle(find.kind),
            clipRoots: navigatorClipRoots,
          })
        : this.route.navigator === "files"
          ? this.fileNavigator.scrollSurfaceScope({
              scopeId: `${scopeId}:files`,
              label: "Files",
              clipRoots: navigatorClipRoots,
            })
          : this.route.scope === "branch"
            ? this.branchChanges.scrollSurfaceScope({
                scopeId: `${scopeId}:branch`,
                label: "Branch changes",
                clipRoots: navigatorClipRoots,
              })
            : this.workingTreeChanges.scrollSurfaceScope({
                scopeId: `${scopeId}:working`,
                label: "Working tree changes",
                clipRoots: navigatorClipRoots,
              });
    const viewerScope =
      this.split.detailShown() &&
      hasScrollLayoutBox(viewerPane) &&
      this.route.path
        ? this.selectedFile.scrollSurfaceScope({
            scopeId: `${scopeId}:viewer`,
            clipRoots: viewerClipRoots,
          })
        : null;
    return mergeScrollSurfaceScopes(navigatorScope, viewerScope);
  }

  keyboardNavigationContexts() {
    const subjectId = taskThreadId(this.task);
    if (
      !this.active ||
      this.hidden ||
      !subjectId ||
      !this.contextKey ||
      !this.route.path ||
      !this.split.detailShown() ||
      !hasActionHintLayoutBox(this.viewerPane.value ?? null)
    ) {
      return [];
    }
    return this.selectedFile.keyboardNavigationContexts({
      scopeId: `review:${encodeURIComponent(subjectId)}:viewer`,
    });
  }

  // The navigator the workspace's side pane toggle hides and shows.
  sidePane() {
    return this.split.sidePane();
  }

  private setTaskContext(
    task: ReviewTask | null,
    route: ReviewRouteInput | null,
  ) {
    const contextKey = reviewContextKey(task);
    const contextChanged = contextKey !== this.contextKey;
    const previousRoute = this.route;
    // Review applies the route fitted to the Task and the file, so the route
    // it compares the next one with is always one it showed; an address that
    // names another is corrected afterwards.
    const requestedRoute = normalizeReviewRoute(route, task);
    const nextRoute = normalizeForTask(requestedRoute, task);
    const nextRouteKey = reviewRouteKey(nextRoute);
    const addressDiffers = reviewRouteKey(requestedRoute) !== nextRouteKey;
    const routeChanged = Boolean(
      this.previousRouteKey && this.previousRouteKey !== nextRouteKey,
    );
    // Opening or closing a find leaves the file as it is.
    const viewChanged =
      routeChanged &&
      reviewRouteKey({ ...previousRoute, find: null }) !==
        reviewRouteKey({ ...nextRoute, find: null });
    const scopeChanged =
      routeChanged && previousRoute.scope !== nextRoute.scope;
    const revealFileSelection = Boolean(
      nextRoute.navigator === "files" &&
        nextRoute.path &&
        (contextChanged ||
          previousRoute.navigator !== "files" ||
          previousRoute.path !== nextRoute.path),
    );
    if (this.active && !contextChanged && !routeChanged) {
      // Detail hands the context over on every Task update; keep its newest
      // branch and HEAD for later requests without restarting any load.
      this.task = task;
      this.syncChildContexts();
      if (addressDiffers) {
        this.requestRoute(nextRoute);
      }
      return false;
    }
    if (contextChanged) {
      this.resetContext();
      this.contextKey = contextKey;
    } else if (routeChanged) {
      this.captureLocalState();
    }
    this.active = true;
    this.task = task;
    this.route = nextRoute;
    this.previousRouteKey = nextRouteKey;
    this.syncChildContexts();
    this.syncReview({
      contextChanged,
      routeChanged: viewChanged,
      scopeChanged,
      revealFileSelection,
      findClosed: Boolean(previousRoute.find && !nextRoute.find),
    });
    if (addressDiffers) {
      this.requestRoute(nextRoute);
    }
    return true;
  }

  private chooseAxis(event: CustomEvent<SegmentedControlIntentDetail>) {
    event.stopPropagation();
    const axis = (event.currentTarget as HTMLElement).dataset.reviewAxis;
    const value = `${event.detail?.value ?? ""}`;
    if (axis === "navigator") {
      this.updateRoute({ navigator: value === "files" ? "files" : "changes" });
    } else {
      this.chooseViewer(value);
    }
  }

  private reviewBranch(event: Event) {
    event.stopPropagation();
    this.updateRoute({ scope: "branch" });
  }

  private chooseRepresentation(
    event: CustomEvent<ReviewRepresentationIntentDetail>,
  ) {
    event.stopPropagation();
    this.chooseViewer(`${event.detail?.representation ?? ""}`);
  }

  private chooseBase(event: CustomEvent<ReviewBaseIntentDetail>) {
    event.stopPropagation();
    this.captureLocalState();
    this.requestRoute({
      ...this.route,
      baseRef: `${event.detail?.baseRef ?? ""}`,
    });
  }

  private followChangesRead(event: CustomEvent<ChangesRead>) {
    event.stopPropagation();
    const changes = event.currentTarget as ReviewChangesElement;
    const { ok, hadData, wasOutdated, background = false } = event.detail;
    this.patchErrorState();
    this.patchListName();
    this.patchAdjacentFiles();
    if (!ok) {
      this.followRereadInViewer(changes);
      return;
    }
    // Working Tree is read in the background while Branch is shown; only the
    // shown scope's read concerns the viewer.
    if (changes !== this.shownChanges) {
      return;
    }
    const canRefreshViewer = Boolean(this.route.path);
    const pendingWatchViewerRefresh = this.pendingWatchViewerRefresh;
    this.pendingWatchViewerRefresh = false;
    // A watch change reloads the viewer only for its own file or a moved
    // ref, unless the changes it replaces were read before the page came
    // back.
    const refreshViewer = background
      ? canRefreshViewer && (pendingWatchViewerRefresh || wasOutdated)
      : canRefreshViewer;
    if (refreshViewer) {
      this.selectedFile.reload(this.currentView(), {
        background,
        reread: hadData,
      });
    }
  }

  private openChange(
    event: CustomEvent<
      | FileNavigatorOpenFileDetail
      | OpenCompareDiffDetail
      | OpenGitDiffDetail
      | FileViewerOpenAdjacentDetail
    >,
  ) {
    event.stopPropagation();
    const relative = relativeTaskPath(
      event.detail?.path,
      taskRootPath(this.task),
    );
    if (!relative) {
      return;
    }
    this.split.closeDrawer();
    this.requestRoute(routeForSelectedFile(this.route, relative));
  }

  private refreshFile(event: CustomEvent<FileNavigatorRefreshSelectedDetail>) {
    event.stopPropagation();
    if (isFileRepresentation(this.route.viewer)) {
      this.selectedFile.reload(this.currentView(), { background: true });
    }
  }

  private closeFile(event: Event) {
    event.stopPropagation();
    if (!this.route.path) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, path: "", line: null });
  }

  private resetContext() {
    this.placesReading?.abort();
    this.placesReading = null;
    this.placesRead = null;
    this.unsubscribeWatch();
    this.pendingWatchViewerRefresh = false;
    this.previousRouteKey = "";
    this.fileNavigator.clearSelectedPath();
  }

  private syncChildContexts() {
    const worktreeRootPath = taskWorktreeRootPath(this.task);
    const branch = this.task?.worktree?.branch ?? null;
    this.workingTreeChanges.setContext({ rootPath: worktreeRootPath, branch });
    this.branchChanges.setContext({
      rootPath: worktreeRootPath,
      branch,
      baseRef: this.route.baseRef,
    });
    this.branchChanges.setShown(this.route.scope === "branch");
    this.selectedFile.setContext({
      rootPath: taskRootPath(this.task),
      worktreeRootPath,
    });
  }

  private markChangesOutdated() {
    this.workingTreeChanges.markOutdated();
    this.branchChanges.markOutdated();
  }

  private syncReview(options: SyncOptions = {}) {
    if (!this.active || !this.task) {
      return;
    }
    this.patchControls();
    this.patchLayout();
    this.syncSelection();
    this.ensureFileNavigator({
      refresh: options.reactivated,
      revealSelection: options.revealFileSelection || options.reactivated,
    });
    this.subscribeWatch(taskRootPath(this.task));
    if (this.task.worktree) {
      const working = this.workingTreeChanges.snapshot();
      if (
        options.contextChanged ||
        options.reactivated ||
        !working.data ||
        (options.scopeChanged &&
          this.route.scope === "working" &&
          working.outdated)
      ) {
        void this.readChanges(this.workingTreeChanges);
      }
      if (this.route.scope === "branch") {
        const branch = this.branchChanges.snapshot();
        if (
          options.reactivated ||
          (options.scopeChanged && branch.outdated) ||
          !branch.hasRefs ||
          !branch.data
        ) {
          void this.readChanges(this.branchChanges, {
            force: branch.outdated,
          });
        }
      }
    }
    const reload = Boolean(
      options.contextChanged || options.routeChanged || options.reactivated,
    );
    this.selectedFile.show(this.currentView(), { force: reload });
    if (reload || options.findClosed) {
      this.restoreNavigatorScroll();
    }
    if (
      options.contextChanged ||
      options.reactivated ||
      taskRootPath(this.task) !== this.languageServersPath
    ) {
      void this.readLanguageServers({ lookAgain: true });
    }
    this.syncCodeNames();
    this.syncPlaces();
  }

  private ensureFileNavigator({
    refresh = false,
    revealSelection = false,
  }: {
    refresh?: boolean;
    revealSelection?: boolean;
  }) {
    const navigator = this.fileNavigator;
    const rootPath = taskRootPath(this.task);
    if (!rootPath) {
      return;
    }
    navigator.setWatchActive(false);
    const selectedPath =
      this.route.navigator === "files" && this.route.path
        ? this.logicalSelectedPath()
        : "";
    if (selectedPath) {
      if (revealSelection) {
        void navigator
          .resolvePath(selectedPath, { fallbackPath: rootPath })
          .then(async () => {
            if (selectedPath === this.logicalSelectedPath()) {
              await navigator.revealPath(selectedPath);
            }
          })
          .then(() => {
            if (refresh && selectedPath === this.logicalSelectedPath()) {
              void navigator.requestRefresh({ allDirectories: true });
            }
          });
      } else if (refresh) {
        void navigator.requestRefresh({ allDirectories: true });
      }
      return;
    }
    if (!navigator.hasLoadedDirectory(rootPath)) {
      void navigator.loadDirectory(rootPath, { allowFailure: true });
    } else if (refresh) {
      void navigator.requestRefresh({ allDirectories: true });
    }
  }

  private readChanges(
    changes: ReviewChangesElement,
    options: { background?: boolean; force?: boolean } = {},
  ) {
    const reading = changes.read(options);
    this.followRereadInViewer(changes);
    return reading;
  }

  // Where the shown changes from before the page came back say the selected
  // file did not change, the viewer follows their reread: loading while it
  // runs, then the read's error if it fails.
  private followRereadInViewer(changes: ReviewChangesElement) {
    if (
      changes !== this.shownChanges ||
      !this.route.path ||
      isFileRepresentation(this.route.viewer)
    ) {
      return;
    }
    const { data, outdated } = changes.snapshot();
    if (!outdated || !data || changes.change(this.logicalSelectedPath())) {
      return;
    }
    this.selectedFile.reload(this.currentView());
  }

  private currentView(): ReviewView {
    const logicalPath = this.logicalSelectedPath();
    return {
      stateKey: viewerStateKey(this.route),
      scope: this.route.scope,
      path: this.route.path,
      logicalPath,
      representation: this.route.viewer,
      line: this.route.line,
      entry: logicalPath
        ? (this.fileNavigator.entryForPath(logicalPath) ?? null)
        : null,
      changes: this.viewerChanges(logicalPath),
    };
  }

  private viewerChanges(logicalPath: string): ReviewChanges {
    if (!this.task?.worktree) {
      return {
        ready: false,
        outdated: false,
        failed: false,
        error: null,
        change: null,
        base: "",
        diffKind: "",
        readDiff: null,
        readVersions: null,
      };
    }
    const changes = this.shownChanges;
    const { data, error, outdated, failed } = changes.snapshot();
    return {
      ready: Boolean(data),
      outdated,
      failed,
      error,
      change: logicalPath ? changes.change(logicalPath) : null,
      base: changes.base(),
      diffKind: changes.diffKind(),
      readDiff: () => changes.readDiff(logicalPath),
      readVersions: () => changes.readVersions(logicalPath),
    };
  }

  private captureLocalState() {
    const scroll =
      this.route.navigator === "files"
        ? this.fileNavigator.captureScroll()
        : this.shownChanges.captureListScroll();
    if (scroll) {
      this.navigatorScroll.set(this.navigatorStateKey(), scroll);
    }
  }

  private restoreNavigatorScroll() {
    const scroll = this.navigatorScroll.get(this.navigatorStateKey());
    if (!scroll) {
      return;
    }
    if (this.route.navigator === "files") {
      this.fileNavigator.restoreScroll(scroll);
    } else {
      this.shownChanges.restoreListScroll(scroll);
    }
  }

  private patchControls() {
    const gitAvailable = Boolean(this.task?.worktree);
    const navigatorChoices = [
      ...(gitAvailable ? [{ value: "changes", label: "Changes" }] : []),
      { value: "files", label: "Files" },
    ];
    this.dataset.reviewNavigatorChoiceCount = `${navigatorChoices.length}`;
    this.axisControl("navigator").setSnapshot({
      label: "Review navigator",
      actionVerb: "Show",
      selected: this.route.navigator,
      choices: navigatorChoices,
    });
    // With no file selected, the chosen representation stays on offer.
    const offered = (viewer: ReviewViewer) =>
      this.route.path
        ? fileHasRepresentation(this.route.path, viewer)
        : viewer === "diff" ||
          viewer === "source" ||
          viewer === this.route.viewer;
    const viewerChoices = [
      ...(gitAvailable && offered("diff")
        ? [{ value: "diff", label: "Diff" }]
        : []),
      ...(gitAvailable && offered("visual")
        ? [{ value: "visual", label: "Visual" }]
        : []),
      ...(offered("source") ? [{ value: "source", label: "Source" }] : []),
      ...(offered("preview") ? [{ value: "preview", label: "Preview" }] : []),
    ];
    this.dataset.reviewViewerChoiceCount = `${viewerChoices.length}`;
    this.axisControl("viewer").setSnapshot({
      label: "Review viewer",
      actionVerb: "Show",
      selected: this.route.viewer,
      choices: viewerChoices,
    });
    this.patchErrorState();
  }

  private patchErrorState() {
    const error = this.shownChanges.snapshot().error;
    const failed =
      this.route.scope === "branch" ? "Branch comparison" : "Working tree";
    this.errorMessage = error
      ? `${failed} update failed: ${error.message}`
      : "";
  }

  private patchLayout() {
    this.toggleAttribute("data-file-selected", Boolean(this.route.path));
    this.dataset.reviewScope = this.route.scope;
    this.dataset.reviewNavigator = this.route.navigator;
    this.dataset.reviewViewer = this.route.viewer;
    this.split.setDetailOpen(Boolean(this.route.path));
    this.patchListName();
    this.patchAdjacentFiles();
  }

  // A file opened from Changes ends with the changed files before and after
  // it, in the order the list shows them.
  private patchAdjacentFiles() {
    const logicalPath = this.logicalSelectedPath();
    const order =
      this.route.navigator === "changes" && logicalPath && this.task?.worktree
        ? this.shownChanges.changedPathsInOrder()
        : [];
    const index = order.indexOf(logicalPath);
    const describe = (path: string | undefined): AdjacentFile | null => {
      if (!path) {
        return null;
      }
      const shown =
        this.shownChanges.change(path)?.file.repoRelativePath || path;
      const slash = shown.lastIndexOf("/");
      return {
        path,
        name: shown.slice(slash + 1),
        folder: slash > 0 ? shown.slice(0, slash) : "",
      };
    };
    this.selectedFile.setAdjacentFiles({
      previous: index > 0 ? describe(order[index - 1]) : null,
      next: index >= 0 ? describe(order[index + 1]) : null,
    });
  }

  // The strip of the folded drawer names the list it holds.
  private patchListName() {
    const find = this.route.find;
    if (find) {
      const read = this.placesRead;
      this.split.setListName(
        reviewFindTitle(find.kind),
        read?.key === findKey(find) && read.status === "ready"
          ? read.places.length
          : null,
      );
      return;
    }
    if (this.route.navigator === "files") {
      this.split.setListName("Files");
      return;
    }
    const { data } = this.shownChanges.snapshot();
    this.split.setListName("Changes", data?.files?.length ?? null);
  }

  private syncSelection() {
    const logicalPath = this.logicalSelectedPath();
    this.workingTreeChanges.setSelectedPath(logicalPath);
    this.branchChanges.setSelectedPath(logicalPath);
    this.fileNavigator.setSelectedPath(logicalPath);
  }

  private chooseViewer(value: string) {
    if (isReviewViewer(value)) {
      this.updateRoute({ viewer: value });
    }
  }

  private updateRoute(
    change: Partial<Pick<ReviewRoute, "scope" | "navigator" | "viewer">>,
  ) {
    const route = { ...this.route, ...change };
    if (reviewRouteKey(route) === reviewRouteKey(this.route)) {
      return;
    }
    this.captureLocalState();
    this.requestRoute(route);
  }

  private requestRoute(state: ReviewRoute) {
    const route = taskRouteForReview(taskThreadId(this.task), state);
    this.dispatchEvent(
      new CustomEvent<TaskReviewRouteIntentDetail>(
        "caffold:task-review-route-intent",
        {
          bubbles: true,
          composed: true,
          detail: { route },
        },
      ),
    );
  }

  private async refreshAll() {
    this.markChangesOutdated();
    const requests: Array<Promise<unknown>> = [
      this.fileNavigator.requestRefresh({
        allDirectories: true,
        selected: Boolean(this.route.path),
      }),
    ];
    if (this.task?.worktree) {
      requests.push(
        this.route.scope === "branch"
          ? this.readChanges(this.branchChanges, { force: true })
          : this.readChanges(this.workingTreeChanges),
      );
    }
    await Promise.allSettled(requests);
  }

  private subscribeWatch(path: string) {
    if (!path || (path === this.watchPath && this.watchUnsubscribe)) {
      return;
    }
    this.unsubscribeWatch();
    this.watchPath = path;
    this.watchUnsubscribe = subscribeToWatch(this.liveUpdates, path, {
      onReady: ({ recovered }) => {
        if (path !== this.watchPath) {
          return;
        }
        if (recovered) {
          void this.refreshAll();
        }
      },
      onRecover: () => {
        if (path !== this.watchPath) {
          return;
        }
        void this.refreshAll();
      },
      onChange: (change) => {
        if (path !== this.watchPath) {
          return;
        }
        void this.fileNavigator.requestRefresh({
          paths: change.paths ?? [],
          allDirectories: Boolean(change.overflow),
          selected: Boolean(
            this.route.path &&
              (change.overflow ||
                (change.paths ?? []).includes(this.logicalSelectedPath())),
          ),
          revision: change.revision,
        });
        if (!this.task?.worktree) {
          return;
        }
        // Both scopes compare the working tree with a commit, so a moved ref
        // can change the shown file's diff and Source marks even when the
        // file itself did not change.
        this.pendingWatchViewerRefresh ||= Boolean(
          change.gitRefsChanged ||
            (change.gitStatusChanged &&
              watchChangeAffectsPath(change, this.logicalSelectedPath())),
        );
        // Working Tree compares with HEAD, so a moved ref changes it too.
        if (change.gitStatusChanged || change.gitRefsChanged) {
          void this.readChanges(this.workingTreeChanges, {
            background: true,
          });
        }
        if (change.gitRefsChanged) {
          if (this.route.scope === "branch") {
            void this.readChanges(this.branchChanges, { force: true });
          } else {
            this.branchChanges.forgetRefs();
          }
        } else if (change.gitStatusChanged && this.route.scope === "branch") {
          void this.readChanges(this.branchChanges, { background: true });
        }
      },
    });
  }

  private unsubscribeWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
  }

  // Reads whether the Task root's repository has language servers on, and
  // reads again while one gets ready. As Review shows the repository, the
  // read first has the server look again for a failed server, which the
  // person may have installed meanwhile. A failed read leaves the names
  // plain; Task details is where the servers' state shows.
  private async readLanguageServers({ lookAgain = false } = {}) {
    if (!this.active || !this.task) {
      return;
    }
    const path = taskRootPath(this.task);
    this.stopLanguageServers();
    const read = this.languageServersRead;
    const reading = new AbortController();
    this.languageServersReading = reading;
    if (path !== this.languageServersPath) {
      this.languageServersPath = path;
      this.languageServers = null;
      this.languageServersKnown = false;
      this.syncCodeNames();
    }
    let repository: LanguageServerRepository | null = null;
    try {
      repository = await (lookAgain
        ? checkLanguageServerRepository
        : getLanguageServerRepository)(path, reading.signal);
    } catch {
      repository = null;
    }
    if (read !== this.languageServersRead) {
      return;
    }
    this.languageServersReading = null;
    this.languageServers = repository;
    this.languageServersKnown = true;
    this.syncCodeNames();
    this.syncPlaces();
    if (languageServersGettingReady(repository)) {
      this.languageServersTimer = setTimeout(() => {
        void this.readLanguageServers();
      }, LANGUAGE_SERVERS_READ_AGAIN_MS);
    }
  }

  private stopLanguageServers() {
    this.languageServersRead += 1;
    this.languageServersReading?.abort();
    this.languageServersReading = null;
    if (this.languageServersTimer !== null) {
      clearTimeout(this.languageServersTimer);
      this.languageServersTimer = null;
    }
  }

  private syncCodeNames() {
    this.selectedFile.setCodeNames(
      codeNamesFor(this.languageServers, this.logicalSelectedPath()),
    );
  }

  private placesSnapshot(): ReviewPlacesSnapshot | null {
    const find = this.route.find;
    if (!find) {
      return null;
    }
    const read =
      this.placesRead?.key === findKey(find) ? this.placesRead : null;
    const shown = {
      kind: find.kind,
      name: read?.name ?? "",
      selected: this.route.path
        ? { path: this.route.path, line: this.route.line }
        : null,
    };
    if (read?.status === "ready") {
      return { ...shown, status: "ready", places: read.places };
    }
    if (read?.status === "failed") {
      return { ...shown, status: "failed", message: read.message };
    }
    return { ...shown, status: "loading" };
  }

  // Reads the places the route's find names once its server can answer:
  // after the repository's servers are read and none of them is still
  // getting ready for the find's file.
  private syncPlaces() {
    const find = this.route.find;
    const key = find ? findKey(find) : "";
    const read = this.placesRead;
    if (
      read?.key === key &&
      (read.status !== "loading" || this.placesReading)
    ) {
      return;
    }
    this.placesReading?.abort();
    this.placesReading = null;
    if (!find) {
      this.placesRead = null;
      return;
    }
    const name = read?.key === key ? read.name : "";
    const path = joinLogicalPath(taskRootPath(this.task), find.path);
    if (
      !this.languageServersKnown ||
      codeNamesFor(this.languageServers, path)?.status === "starting"
    ) {
      this.placesRead = { key, name, status: "loading" };
      return;
    }
    void this.readPlaces(find, key, name, path);
  }

  private async readPlaces(
    find: ReviewFind,
    key: string,
    name: string,
    path: string,
  ) {
    const reading = new AbortController();
    this.placesReading = reading;
    this.placesRead = { key, name, status: "loading" };
    let next: PlacesRead;
    try {
      const { places } = await findLanguageServerPlaces(
        find.kind === "references" ? "references" : "definition",
        { path, line: find.line, character: find.character },
        reading.signal,
      );
      const shown = places.map((place) => this.reviewPlace(place));
      next = {
        key,
        name: name || placeName(shown),
        status: "ready",
        places: shown,
      };
    } catch (error) {
      next = { key, name, status: "failed", message: errorMessage(error) };
    }
    if (this.placesReading !== reading) {
      return;
    }
    this.placesReading = null;
    this.placesRead = next;
    this.patchListName();
  }

  // Answers a press on a name in the viewer. One definition opens; none, a
  // failure, or one outside Caffold's root shows a message at the name; more
  // places open the list.
  private async answerCodeName(event: CustomEvent<CodeNameIntentDetail>) {
    event.stopPropagation();
    const { action, line, character, name } = event.detail;
    const route = this.route;
    const path = this.logicalSelectedPath();
    if (!route.path || !path) {
      return;
    }
    this.codeNameAsking?.abort();
    const asking = new AbortController();
    this.codeNameAsking = asking;
    const position = { line, character };
    let places: ReviewPlace[];
    try {
      const answer = await findLanguageServerPlaces(
        action,
        { path, line, character },
        asking.signal,
      );
      places = answer.places.map((place) => this.reviewPlace(place));
    } catch (error) {
      if (this.codeNameAsking === asking) {
        this.codeNameAsking = null;
        this.selectedFile.showCodeNameMessage(position, errorMessage(error));
      }
      return;
    }
    if (
      this.codeNameAsking !== asking ||
      reviewRouteKey(route) !== reviewRouteKey(this.route)
    ) {
      return;
    }
    this.codeNameAsking = null;
    const [first] = places;
    if (!first) {
      this.selectedFile.showCodeNameMessage(
        position,
        action === "definition"
          ? "No definition found."
          : "No references found.",
      );
      return;
    }
    if (action === "definition" && places.length === 1) {
      if (first.path) {
        this.openFileAt(first.path, first.line);
      } else {
        this.selectedFile.showCodeNameMessage(
          position,
          `Defined in ${first.fileName}, line ${first.line}, outside the folder Caffold serves.`,
        );
      }
      return;
    }
    const find: ReviewFind = {
      kind: action === "definition" ? "definitions" : "references",
      path: route.path,
      line,
      character,
    };
    this.placesReading?.abort();
    this.placesReading = null;
    this.placesRead = { key: findKey(find), name, status: "ready", places };
    this.openFind(find);
  }

  // Shows the find's list in place of the navigator: on a phone in place of
  // the file, elsewhere beside it or in the drawer over it.
  private openFind(find: ReviewFind) {
    this.captureLocalState();
    const onePane = this.split.showsOnePane();
    this.requestRoute({
      ...this.route,
      find,
      ...(onePane ? { path: "", line: null } : {}),
    });
    if (!onePane) {
      this.split.sidePane().setCollapsed(false);
    }
  }

  private openPlace(event: CustomEvent<ReviewPlaceOpenDetail>) {
    event.stopPropagation();
    this.split.closeDrawer();
    this.openFileAt(event.detail.path, event.detail.line);
  }

  private closePlaces(event: Event) {
    event.stopPropagation();
    this.requestRoute({ ...this.route, find: null });
  }

  // Opens a place in Source, as the conversation's file links do.
  private openFileAt(path: string, line: number) {
    this.captureLocalState();
    this.requestRoute({ ...this.route, viewer: "source", path, line });
  }

  private reviewPlace(place: LanguageServerPlace): ReviewPlace {
    return {
      path:
        place.path === null
          ? null
          : reviewPathFor(place.path, taskRootPath(this.task)),
      fileName: place.name,
      line: place.line,
      character: place.character,
      length: place.length ?? null,
      text: place.text ?? null,
    };
  }

  private logicalSelectedPath() {
    return this.route.path
      ? joinLogicalPath(taskRootPath(this.task), this.route.path)
      : "";
  }

  private navigatorStateKey() {
    return `${this.route.scope}:${this.route.navigator}`;
  }

  private get shownChanges(): ReviewChangesElement {
    return this.route.scope === "branch"
      ? this.branchChanges
      : this.workingTreeChanges;
  }

  // The children are drawn the first time one is needed, which can be before
  // Review is in the document.
  private get workingTreeChanges() {
    this.performUpdate();
    return this.workingList.value as CaffoldReviewWorkingTreeChanges;
  }

  private get branchChanges() {
    this.performUpdate();
    return this.branchList.value as CaffoldReviewBranchChanges;
  }

  private get fileNavigator() {
    this.performUpdate();
    return this.filesList.value as CaffoldFileNavigator;
  }

  private get selectedFile() {
    this.performUpdate();
    return this.fileViewer.value as CaffoldReviewSelectedFile;
  }

  private get places() {
    this.performUpdate();
    return this.placesList.value as CaffoldReviewPlaces;
  }

  private get split() {
    this.performUpdate();
    return this.splitView.value as CaffoldSplitView;
  }

  private axisControl(axis: "navigator" | "viewer") {
    this.performUpdate();
    return (axis === "navigator" ? this.navigatorAxis : this.viewerAxis)
      .value as CaffoldSegmentedControl;
  }
}

function findKey(find: ReviewFind) {
  return `${find.kind}:${reviewFindAt(find)}`;
}

// The name the places are of: what the first place that marks it shows.
function placeName(places: readonly ReviewPlace[]) {
  for (const { text, character, length } of places) {
    if (text !== null && length) {
      return text.slice(character, character + length);
    }
  }
  return "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : `${error}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-review": CaffoldTaskReview;
  }

  interface HTMLElementEventMap {
    "caffold:review-changes-read": CustomEvent<ChangesRead>;
    "caffold:task-review-route-intent": CustomEvent<TaskReviewRouteIntentDetail>;
  }
}
