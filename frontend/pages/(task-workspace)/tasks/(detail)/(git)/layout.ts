import { html, LitElement, nothing } from "lit";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitRepository } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import { routeMode } from "#app/navigation-routes.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { createRefreshCoordinator, subscribeToWatch } from "#app/watch.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "./(log)/layout.ts";
import type { CaffoldGitLogLayout } from "./(log)/layout.ts";
import "./compare/page.ts";
import type { CaffoldGitComparePage } from "./compare/page.ts";
import "./components/controls.ts";
import {
  type CaffoldGitReviewControls,
  type GitControlsSnapshot,
  IDLE_CONTROLS,
} from "./components/controls.ts";

const BACK_BUTTON =
  ':scope > .task-git-surface > .task-domain-header > .task-domain-back[data-action="domain-back"]';
const BODY = ":scope > .task-git-surface > .task-domain-body";

type GitMode = "compare" | "log";

interface GitRoute {
  kind: string;
  baseRef?: string;
  headRef?: string;
  path?: string;
  page?: number;
  sha?: string;
}

interface RouteOptions {
  activationGeneration?: number;
  forceRefresh?: boolean;
  status?: string;
  resolvePath?: (path: string) => string;
}

// What the header shows, and which route view is on screen.
interface Chrome {
  mode: GitMode | null;
  title: string;
  count: string;
  primaryMeta: string;
  secondaryMeta: string;
  backShown: boolean;
  controls: GitControlsSnapshot;
}

export class CaffoldTaskGitLayout extends LitElement {
  static properties = {
    chrome: { state: true },
  };

  declare private chrome: Chrome;
  // Whether Detail has this layout on screen for a repository.
  active = false;
  private activationGeneration = 0;
  private mode: GitMode | null = null;
  private currentPath = "";
  private repository: GitRepository | null = null;
  private pendingRefresh = false;
  private watchUnavailable = false;
  private refreshState: GitControlsSnapshot["refreshState"] = "idle";
  private liveUpdates: unknown = null;
  private watchScopePath: string | null = null;
  private watchUnsubscribe: (() => void) | null = null;
  private readonly refreshCoordinator = createRefreshCoordinator(
    () => this.performPendingRefresh(),
    (state) => this.setRefreshState(state),
  );
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.chrome = {
      mode: null,
      title: "Git",
      count: "",
      primaryMeta: "",
      secondaryMeta: "",
      backShown: false,
      controls: IDLE_CONTROLS,
    };
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    if (this.active && this.watchScopePath) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const chrome = this.chrome;
    const backIcon = inlineIcon(
      "ArrowLeft",
      "Back to log",
      "task-domain-back-icon",
    );
    return html`
      <section class="task-git-surface" aria-label="Git">
        <header class="task-domain-header">
          <button
            type="button"
            class="task-domain-back"
            data-action="domain-back"
            aria-label="Back to log"
            title="Back to log"
            ?hidden=${!chrome.backShown}
            @click=${this.backToLog}
          >${backIcon}</button>
          <div class="task-domain-title">
            <div class="task-domain-title-row">
              <h2>${chrome.title}</h2>
              <span
                class="task-domain-count"
                ?hidden=${!chrome.count}
                title=${chrome.count || nothing}
              >${chrome.count}</span>
            </div>
            <div
              class="task-domain-meta-row"
              ?hidden=${!chrome.primaryMeta && !chrome.secondaryMeta}
            >
              <span
                class="task-domain-primary-meta"
                ?hidden=${!chrome.primaryMeta}
                title=${chrome.primaryMeta || nothing}
              >${chrome.primaryMeta}</span>
              <span
                class="task-domain-secondary-meta"
                ?hidden=${!chrome.secondaryMeta}
                title=${chrome.secondaryMeta || nothing}
              >${chrome.secondaryMeta}</span>
            </div>
          </div>
          <caffold-git-review-controls
            .snapshot=${chrome.controls}
            @caffold:fetch-git-remote=${this.fetchFromControls}
          ></caffold-git-review-controls>
        </header>
        <div class="task-domain-body">
          <div
            class="git-review-view git-mode-compare"
            ?hidden=${chrome.mode !== "compare"}
          >
            <caffold-git-compare-page
              @caffold:git-compare-state-change=${this.followCompare}
              @caffold:open-compare-diff=${this.openCompareDiff}
              @caffold:close-file-viewer=${this.closeCompareFile}
            ></caffold-git-compare-page>
          </div>
          <div
            class="git-review-view git-mode-log"
            ?hidden=${chrome.mode !== "log"}
          >
            <caffold-git-log-layout
              @caffold:git-log-state-change=${this.followLog}
              @caffold:open-git-commit=${this.openCommit}
              @caffold:change-log-page=${this.changeLogPage}
              @caffold:open-commit-diff=${this.openCommitDiff}
              @caffold:close-file-viewer=${this.closeCommitFile}
            ></caffold-git-log-layout>
          </div>
        </div>
      </section>
    `;
  }

  setLiveUpdates(liveUpdates: unknown) {
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    const path = this.watchScopePath;
    this.unsubscribeWatchScope();
    this.liveUpdates = liveUpdates ?? null;
    if (path && this.active && this.isConnected) {
      this.subscribeWatchScope(path);
    }
  }

  async activate(
    route: GitRoute,
    options: {
      context?: { path?: string; repository?: GitRepository | null };
      routeOptions?: RouteOptions;
    } = {},
  ) {
    this.active = true;
    const generation = ++this.activationGeneration;
    this.comparePage.invalidateRequests();
    this.logLayout.invalidateRequests();
    this.setContext(options.context);
    this.setWatchScope(this.repository?.rootPath ?? null);
    const result = await this.openRoute(route, {
      ...options.routeOptions,
      activationGeneration: generation,
      forceRefresh: true,
    });
    return this.active && generation === this.activationGeneration
      ? result
      : null;
  }

  deactivate() {
    this.comparePage.deactivate();
    this.logLayout.deactivate();
    if (!this.active) {
      return;
    }
    this.active = false;
    this.activationGeneration += 1;
    this.pendingRefresh = false;
    this.unsubscribeWatchScope();
    this.comparePage.invalidateRequests();
    this.logLayout.invalidateRequests();
    this.setRefreshState("idle");
  }

  reset() {
    this.deactivate();
    this.mode = null;
    this.dataset.gitMode = "";
    this.currentPath = "";
    this.repository = null;
    this.watchScopePath = null;
    this.comparePage.reset();
    this.logLayout.reset();
    this.updateChrome();
  }

  refresh() {
    return this.requestRefresh();
  }

  prepareRoute(route: GitRoute) {
    const mode = routeMode(route);
    if (mode === "compare") {
      this.setMode("compare");
      this.comparePage.setContext({
        path: this.currentPath,
        repository: this.repository,
        baseRef: route.baseRef,
        headRef: route.headRef,
      });
      if (route.path) {
        this.comparePage.setView("viewer");
      } else {
        this.comparePage.showList();
        this.comparePage.setSelectedPath("");
        this.comparePage.setEmpty();
      }
    } else if (mode === "log") {
      this.setMode("log");
      this.logLayout.setContext({
        path: this.currentPath,
        repository: this.repository,
      });
      this.logLayout.prepareRoute(route);
    }
    this.updateChrome();
  }

  sidePane() {
    if (!this.active || this.hidden || !this.mode) {
      return null;
    }
    return this.mode === "compare"
      ? this.comparePage.sidePane()
      : this.logLayout.sidePane();
  }

  actionHintScope() {
    if (!this.active || this.hidden || !this.mode) {
      return emptyActionHintScope();
    }
    const scopeId = this.scopeId();
    const body = this.querySelector(BODY);
    const clipRoots = body ? [this, body] : [this];
    const back = this.querySelector<HTMLButtonElement>(BACK_BUTTON);
    const backScope =
      back && !back.hidden && !back.disabled
        ? {
            blocked: false,
            targets: [
              buttonActionHintTarget({
                invalidationOwner: this,
                id: `${scopeId}:parent:log`,
                actionId: ACTION_HINT_ACTION.PARENT,
                label: back.getAttribute("aria-label") || "Back to log",
                control: back,
                clipRoots: [this],
                isActionable: () =>
                  this.isConnected &&
                  this.active &&
                  !this.hidden &&
                  this.querySelector(BACK_BUTTON) === back &&
                  !back.hidden &&
                  !back.disabled,
              }),
            ],
            mutationRoots: [back],
            scrollRoots: [],
          }
        : null;
    return mergeActionHintScopes(
      backScope,
      this.controls.actionHintScope({ scopeId, clipRoots: [this] }),
      this.mode === "compare"
        ? this.comparePage.actionHintScope({
            scopeId: `${scopeId}:compare`,
            clipRoots,
          })
        : this.logLayout.actionHintScope({
            scopeId: `${scopeId}:log`,
            clipRoots,
          }),
    );
  }

  scrollSurfaceScope() {
    if (!this.active || this.hidden || !this.mode) {
      return emptyScrollSurfaceScope();
    }
    const scopeId = this.scopeId();
    const body = this.querySelector(BODY);
    const clipRoots = body ? [this, body] : [this];
    return this.mode === "compare"
      ? this.comparePage.scrollSurfaceScope({
          scopeId: `${scopeId}:compare`,
          clipRoots,
        })
      : this.logLayout.scrollSurfaceScope({
          scopeId: `${scopeId}:log`,
          clipRoots,
        });
  }

  keyboardNavigationContexts() {
    if (!this.active || this.hidden || !this.mode) {
      return [];
    }
    const scopeId = this.scopeId();
    return this.mode === "compare"
      ? this.comparePage.keyboardNavigationContexts({
          scopeId: `${scopeId}:compare`,
        })
      : this.logLayout.keyboardNavigationContexts({
          scopeId: `${scopeId}:log`,
        });
  }

  private setContext({
    path,
    repository,
  }: {
    path?: string;
    repository?: GitRepository | null;
  } = {}) {
    const nextPath = path ?? this.currentPath;
    const nextRepository = repository ?? this.repository;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath;
    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.comparePage.setContext({ path: nextPath, repository: nextRepository });
    this.logLayout.setContext({ path: nextPath, repository: nextRepository });
    this.setWatchScope(nextRepository?.rootPath ?? null);
    if (contextChanged) {
      this.pendingRefresh = false;
    }
  }

  private setWatchScope(path: string | null) {
    if (this.watchScopePath === path && this.watchUnsubscribe) {
      return;
    }
    this.watchScopePath = path;
    this.unsubscribeWatchScope();
    this.watchUnavailable = false;
    this.setRefreshState("idle");
    if (path && this.active && this.isConnected) {
      this.subscribeWatchScope(path);
    }
  }

  private subscribeWatchScope(path: string) {
    if (this.watchUnsubscribe || !this.active) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(this.liveUpdates, path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          void this.requestRefresh();
        }
      },
      onChange: (change) => {
        if (change.gitRefsChanged) {
          void this.requestRefresh();
        }
      },
      onRecover: () => void this.requestRefresh(),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  private unsubscribeWatchScope() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
  }

  private async fetchRemote() {
    if (
      !this.active ||
      this.mode !== "log" ||
      !this.logLayout.repository ||
      this.logLayout.fetchState.status === "fetching"
    ) {
      return null;
    }
    return await this.logLayout.fetchRemote();
  }

  private requestRefresh() {
    if (!this.active || !this.repository) {
      return Promise.resolve();
    }
    this.pendingRefresh = true;
    return this.refreshCoordinator.request();
  }

  private async performPendingRefresh() {
    if (!this.active || !this.pendingRefresh) {
      this.pendingRefresh = false;
      return;
    }
    this.pendingRefresh = false;
    if (this.mode === "compare") {
      await this.comparePage.refresh();
    } else if (this.mode === "log") {
      await this.logLayout.refresh();
    }
  }

  private setRefreshState(state: string) {
    this.refreshState =
      state === "refreshing"
        ? "refreshing"
        : this.watchUnavailable
          ? "unavailable"
          : "idle";
    this.updateChrome();
  }

  private async openRoute(route: GitRoute, options: RouteOptions = {}) {
    this.prepareRoute(route);
    const mode = routeMode(route);
    if (!this.repository) {
      return null;
    }
    if (mode === "compare") {
      this.comparePage.setContext({
        path: this.currentPath,
        repository: this.repository,
        baseRef: route.baseRef || null,
        headRef: route.headRef || null,
      });
      const compare = options.forceRefresh
        ? await this.comparePage.refresh()
        : await this.comparePage.openCompare({
            path: this.currentPath,
            repository: this.repository,
            baseRef: route.baseRef || null,
            headRef: route.headRef || null,
            preserveViewer: Boolean(route.path),
          });
      if (!this.isCurrentActivation(options.activationGeneration)) {
        return null;
      }
      if (!route.path) {
        this.comparePage.showList();
        this.comparePage.setSelectedPath("");
        this.updateChrome();
        return compare;
      }
      const fullPath = this.resolveRoutePath(route.path, options);
      const file = this.comparePage.fileForPath(fullPath);
      return fullPath
        ? await this.comparePage.openDiff(
            fullPath,
            file?.status ?? options.status ?? "",
          )
        : null;
    }
    if (mode !== "log") {
      return null;
    }
    if (!route.sha) {
      const log = await this.logLayout.openList({
        path: this.currentPath,
        repository: this.repository,
        page: route.page ?? 1,
      });
      if (!this.isCurrentActivation(options.activationGeneration)) {
        return null;
      }
      this.updateChrome();
      return log;
    }
    const commit = await this.logLayout.openCommit(route.sha, {
      path: this.currentPath,
      repository: this.repository,
      page: route.page,
      preserveViewer: Boolean(route.path),
    });
    if (!this.isCurrentActivation(options.activationGeneration)) {
      return null;
    }
    if (!route.path) {
      this.updateChrome();
      return commit;
    }
    const fullPath = this.resolveRoutePath(route.path, options);
    const file = this.logLayout.findCommitFile(fullPath);
    return fullPath
      ? await this.logLayout.openCommitDiff(
          route.sha,
          fullPath,
          file?.status ?? options.status ?? "",
        )
      : null;
  }

  private isCurrentActivation(generation: number | undefined) {
    return (
      this.active &&
      (generation === undefined || generation === this.activationGeneration)
    );
  }

  private resolveRoutePath(path: string, options: RouteOptions) {
    return options.resolvePath ? options.resolvePath(path) : path;
  }

  private fetchFromControls(event: Event) {
    event.stopPropagation();
    void this.fetchRemote();
  }

  private backToLog() {
    if (this.mode === "log" && this.logLayout.view === "detail") {
      this.requestGitRoute({ kind: "log", page: this.logLayout.page });
    }
  }

  private followCompare() {
    if (this.comparePage.repository) {
      this.repository = this.comparePage.repository;
    }
    this.updateChrome();
  }

  private followLog() {
    this.updateChrome();
  }

  private openCompareDiff(
    event: CustomEvent<{ path: string; status: string }>,
  ) {
    event.stopPropagation();
    this.requestGitRoute(
      {
        kind: "compare",
        baseRef: this.comparePage.baseRef ?? "",
        headRef: this.comparePage.headRef ?? "",
        path: event.detail.path,
      },
      { status: event.detail.status },
    );
  }

  private closeCompareFile(event: Event) {
    event.stopPropagation();
    this.requestGitRoute({
      kind: "compare",
      baseRef: this.comparePage.baseRef ?? "",
      headRef: this.comparePage.headRef ?? "",
      path: "",
    });
  }

  private openCommit(event: CustomEvent<{ sha: string }>) {
    event.stopPropagation();
    this.requestGitRoute({
      kind: "log",
      page: this.logLayout.page,
      sha: event.detail.sha,
    });
  }

  private changeLogPage(event: CustomEvent<{ page: number }>) {
    event.stopPropagation();
    this.requestGitRoute({ kind: "log", page: event.detail.page });
  }

  private openCommitDiff(
    event: CustomEvent<{ sha: string; path: string; status: string }>,
  ) {
    event.stopPropagation();
    this.requestGitRoute(
      {
        kind: "log",
        page: this.logLayout.page,
        sha: event.detail.sha,
        path: event.detail.path,
      },
      { status: event.detail.status },
    );
  }

  private closeCommitFile(event: Event) {
    const sha = this.logLayout.currentCommitSha();
    if (!sha) {
      return;
    }
    event.stopPropagation();
    this.requestGitRoute({
      kind: "log",
      page: this.logLayout.page,
      sha,
      path: "",
    });
  }

  private requestGitRoute(route: GitRoute, options: { status?: string } = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-git-route", {
        bubbles: true,
        detail: { route, options },
      }),
    );
  }

  private setMode(mode: GitMode) {
    if (this.mode === mode) {
      return;
    }
    if (mode === "compare") {
      this.logLayout.deactivate();
    } else {
      this.comparePage.deactivate();
    }
    this.mode = mode;
    this.dataset.gitMode = mode;
  }

  // Reads what the header shows from the open route's page and draws it
  // before Detail reads the layout again.
  private updateChrome() {
    const mode = this.mode;
    const compare = this.comparePage;
    const log = this.logLayout;
    const commit = mode === "log" && log.view === "detail";
    const fileOpen =
      (mode === "compare" && compare.detailView === "viewer") ||
      (commit && log.detailView === "viewer");
    const parts = mode === "log" && !commit ? log.logSubtitleParts() : null;
    this.chrome = {
      mode,
      title: commit ? "Commit" : mode === "log" ? "Log" : "Compare",
      count: parts?.count ?? "",
      primaryMeta: commit
        ? log.commitSubtitle()
        : parts
          ? parts.branch
          : this.repository
            ? `${this.repository.branch ?? "HEAD"}`
            : "",
      secondaryMeta: parts?.relationship ?? "",
      backShown: commit && !fileOpen,
      controls: {
        mode,
        action: mode === "log" && !commit ? "fetch" : "refresh",
        fetchState: log.fetchState,
        refs: mode === "compare" ? (compare.refsPayload?.refs ?? []) : [],
        baseRef: mode === "compare" ? (compare.baseRef ?? "") : "",
        headRef: mode === "compare" ? (compare.headRef ?? "") : "",
        refreshState: this.refreshState,
      },
    };
    this.performUpdate();
  }

  private scopeId() {
    return `git:${encodeURIComponent(
      this.repository?.rootPath || this.currentPath || "repository",
    )}`;
  }

  // The children are drawn the first time one is needed, which can be before
  // the layout is in the document.
  private get controls() {
    this.performUpdate();
    return this.querySelector(
      "caffold-git-review-controls",
    ) as CaffoldGitReviewControls;
  }

  private get comparePage() {
    this.performUpdate();
    return this.querySelector(
      "caffold-git-compare-page",
    ) as CaffoldGitComparePage;
  }

  private get logLayout() {
    this.performUpdate();
    return this.querySelector("caffold-git-log-layout") as CaffoldGitLogLayout;
  }
}

await compactIconButton.register(
  "caffold-task-git-layout",
  "> .task-git-surface > .task-domain-header > .task-domain-back",
);

customElements.define("caffold-task-git-layout", CaffoldTaskGitLayout);
