import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type GitHubStatus,
  type GitRepository,
  getGitHubStatus,
} from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import { routeMode } from "#app/navigation-routes.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "./(issues)/layout.js";
import type { CaffoldGithubIssuesLayout } from "./(issues)/layout.js";
import "./(pulls)/layout.js";
import type { CaffoldGithubPullsLayout } from "./(pulls)/layout.js";
import "./components/task-start-dialog.js";
import type {
  CaffoldGithubTaskStartDialog,
  TaskStartSource,
} from "./components/task-start-dialog.js";

type GithubMode = "issues" | "pulls";

interface GithubRoute {
  kind: string;
  page?: number;
  number?: number | null;
  files?: boolean;
  path?: string;
}

interface RouteOptions {
  activationGeneration?: number;
  status?: string;
  resolvePath?: (path: string) => string;
}

// What the header shows, and which route view is on screen.
interface Chrome {
  mode: GithubMode | null;
  title: string;
  subtitle: string;
  backLabel: string;
  backShown: boolean;
  // Which route Back returns to, empty where there is none.
  parentKey: string;
}

await compactIconButton.register(
  "caffold-task-github-layout",
  "> .task-github-surface > .task-domain-header > .task-domain-back",
);

@customElement("caffold-task-github-layout")
export class CaffoldTaskGithubLayout extends LitElement {
  @state()
  private accessor chrome: Chrome = {
    mode: null,
    title: "GitHub",
    subtitle: "",
    backLabel: "Back",
    backShown: false,
    parentKey: "",
  };

  // Whether Detail has this layout on screen for a repository.
  active = false;
  private activationGeneration = 0;
  private mode: GithubMode | null = null;
  private currentPath = "";
  private repository: GitRepository | null = null;
  private composerSettings: unknown = null;
  private githubStatus: GitHubStatus | null = null;
  private githubStatusRequestId = 0;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly issues = new DrawnRef<CaffoldGithubIssuesLayout>(this);
  private readonly pulls = new DrawnRef<CaffoldGithubPullsLayout>(this);
  private readonly startDialog = new DrawnRef<CaffoldGithubTaskStartDialog>(
    this,
  );

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
    const chrome = this.chrome;
    const backIcon = inlineIcon(
      "ArrowLeft",
      chrome.backLabel,
      "task-domain-back-icon",
    );
    return html`
      <section class="task-github-surface" aria-label="GitHub">
        <header class="task-domain-header">
          <button
            ${this.hints.button({
              id: `parent:${chrome.parentKey}`,
              label: chrome.backLabel,
              action: ACTION_HINT_ACTION.PARENT,
              when: Boolean(chrome.parentKey),
            })}
            type="button"
            class="task-domain-back"
            data-action="domain-back"
            aria-label=${chrome.backLabel}
            title=${chrome.backLabel}
            ?hidden=${!chrome.backShown}
            @click=${this.goBack}
          >${backIcon}</button>
          <div class="task-domain-title">
            <h2>${chrome.title}</h2>
            <span class="task-domain-subtitle">${chrome.subtitle}</span>
          </div>
        </header>
        <div ${drawn(this.body)} class="task-domain-body">
          <div
            class="github-review-view github-mode-issues"
            ?hidden=${chrome.mode !== "issues"}
          >
            <caffold-github-issues-layout
              ${drawn(this.issues)}
              @caffold:github-issues-state-change=${this.updateChrome}
              @caffold:open-github-issue=${this.openIssue}
              @caffold:change-github-issues-page=${this.changeIssuesPage}
              @caffold:start-github-task=${this.startTask}
            ></caffold-github-issues-layout>
          </div>
          <div
            class="github-review-view github-mode-pulls"
            ?hidden=${chrome.mode !== "pulls"}
          >
            <caffold-github-pulls-layout
              ${drawn(this.pulls)}
              @caffold:github-pulls-state-change=${this.updateChrome}
              @caffold:open-github-pull=${this.openPull}
              @caffold:change-github-pulls-page=${this.changePullsPage}
              @caffold:open-github-pull-files=${this.openPullFiles}
              @caffold:open-github-pull-file=${this.openPullFile}
              @caffold:close-file-viewer=${this.closePullFile}
              @caffold:start-github-task=${this.startTask}
            ></caffold-github-pulls-layout>
          </div>
        </div>
      </section>
      <caffold-github-task-start-dialog
        ${drawn(this.startDialog)}
      ></caffold-github-task-start-dialog>
    `;
  }

  reset() {
    this.mode = null;
    this.dataset.githubMode = "";
    this.currentPath = "";
    this.repository = null;
    this.composerSettings = null;
    this.githubStatus = null;
    this.githubStatusRequestId += 1;
    this.taskStartDialog.deactivate();
    this.issuesLayout.reset();
    this.pullsLayout.reset();
    this.updateChrome();
  }

  async activate(
    route: GithubRoute,
    options: {
      context?: {
        path?: string;
        repository?: GitRepository | null;
        composerSettings?: unknown;
      };
      routeOptions?: RouteOptions;
    } = {},
  ) {
    this.active = true;
    const generation = ++this.activationGeneration;
    this.githubStatusRequestId += 1;
    this.taskStartDialog.deactivate();
    this.issuesLayout.invalidateRequests();
    this.pullsLayout.invalidateRequests();
    this.setContext({ ...options.context, githubStatus: null });
    const result = await this.openRoute(route, {
      ...options.routeOptions,
      activationGeneration: generation,
    });
    return this.active && generation === this.activationGeneration
      ? result
      : null;
  }

  deactivate() {
    this.taskStartDialog.deactivate();
    this.pullsLayout.deactivate();
    if (!this.active) {
      return;
    }
    this.active = false;
    this.activationGeneration += 1;
    this.githubStatusRequestId += 1;
    this.issuesLayout.invalidateRequests();
    this.pullsLayout.invalidateRequests();
  }

  // Detail hands over the Section's Composer settings here as they change.
  setContext(
    options: {
      path?: string;
      repository?: GitRepository | null;
      composerSettings?: unknown;
      githubStatus?: GitHubStatus | null;
    } = {},
  ) {
    this.currentPath = options.path ?? this.currentPath;
    this.repository = options.repository ?? this.repository;
    if (Object.hasOwn(options, "composerSettings")) {
      this.composerSettings = options.composerSettings ?? null;
      this.taskStartDialog.setComposerSettings(this.composerSettings);
    }
    if (Object.hasOwn(options, "githubStatus")) {
      this.githubStatus = options.githubStatus ?? null;
    }
    const context = {
      path: this.currentPath,
      repository: this.repository,
      githubStatus: this.githubStatus,
    };
    this.issuesLayout.setContext(context);
    this.pullsLayout.setContext(context);
  }

  prepareRoute(route: GithubRoute) {
    this.taskStartDialog.deactivate();
    const mode = routeMode(route);
    if (mode === "issues") {
      this.setMode("issues");
      this.issuesLayout.prepareRoute(route);
    } else if (mode === "pulls") {
      this.setMode("pulls");
      this.pullsLayout.prepareRoute(route);
    }
    this.updateChrome();
  }

  sidePane() {
    if (!this.active || this.hidden || this.mode !== "pulls") {
      return null;
    }
    return this.pullsLayout.sidePane();
  }

  actionHintScope() {
    if (!this.active || this.hidden || !this.mode) {
      return emptyActionHintScope();
    }
    const scopeId = this.scopeId();
    const own = this.hints.scope({ scopeId, clipRoots: [this] });
    const body = this.body.value;
    const clipRoots = body ? [this, body] : [this];
    return mergeActionHintScopes(
      own,
      this.mode === "issues"
        ? this.issuesLayout.actionHintScope({
            scopeId: `${scopeId}:issues`,
            clipRoots,
          })
        : this.pullsLayout.actionHintScope({
            scopeId: `${scopeId}:pulls`,
            clipRoots,
          }),
    );
  }

  scrollSurfaceScope() {
    if (!this.active || this.hidden || !this.mode) {
      return emptyScrollSurfaceScope();
    }
    const body = this.body.value;
    const options = {
      scopeId: `${this.scopeId()}:${this.mode}`,
      clipRoots: body ? [this, body] : [this],
    };
    return this.mode === "issues"
      ? this.issuesLayout.scrollSurfaceScope(options)
      : this.pullsLayout.scrollSurfaceScope(options);
  }

  keyboardNavigationContexts() {
    if (!this.active || this.hidden || !this.mode) {
      return [];
    }
    return mergeKeyboardNavigationContexts(
      this.mode === "pulls"
        ? this.pullsLayout.keyboardNavigationContexts({
            scopeId: `${this.scopeId()}:pulls`,
          })
        : [],
      this.taskStartDialog.keyboardNavigationContexts(),
    );
  }

  private async loadStatus(path: string) {
    if (!this.active || !this.repository) {
      return null;
    }
    const requestId = ++this.githubStatusRequestId;
    this.setContext({ path, githubStatus: null });
    let status: GitHubStatus;
    try {
      status = await getGitHubStatus(path);
    } catch (error) {
      status = {
        repository: this.repository,
        github: null,
        ghAvailable: false,
        authenticated: false,
        issuesAvailable: false,
        pullsAvailable: false,
        message: (error as Error).message,
      };
    }
    if (!this.active || requestId !== this.githubStatusRequestId) {
      return null;
    }
    this.setContext({ githubStatus: status });
    if (this.mode === "issues") {
      this.issuesLayout.setGithubStatus(status);
    } else if (this.mode === "pulls") {
      this.pullsLayout.setGithubStatus(status);
    }
    this.updateChrome();
    return status;
  }

  private async openRoute(route: GithubRoute, options: RouteOptions = {}) {
    this.prepareRoute(route);
    const status =
      this.repository && !this.githubStatus
        ? await this.loadStatus(this.currentPath)
        : this.githubStatus;
    if (!this.isCurrentActivation(options.activationGeneration)) {
      return null;
    }
    this.setContext({ githubStatus: status });
    const mode = routeMode(route);
    if (!this.repository || (mode !== "issues" && mode !== "pulls")) {
      return null;
    }
    if (mode === "issues") {
      this.setMode("issues");
      const result = route.number
        ? await this.issuesLayout.openIssue(route.number, { page: route.page })
        : await this.issuesLayout.openList({
            path: this.currentPath,
            repository: this.repository,
            githubStatus: this.githubStatus,
            page: route.page ?? 1,
          });
      this.updateChrome();
      return result;
    }
    this.setMode("pulls");
    if (!route.number) {
      const pulls = await this.pullsLayout.openList({
        path: this.currentPath,
        repository: this.repository,
        githubStatus: this.githubStatus,
        page: route.page ?? 1,
      });
      this.updateChrome();
      return pulls;
    }
    if (!route.files) {
      const pull = await this.pullsLayout.openPull(route.number, {
        page: route.page,
      });
      this.updateChrome();
      return pull;
    }
    const files = await this.pullsLayout.openFiles(route.number, {
      page: route.page,
      preserveViewer: Boolean(route.path),
      skipReload:
        this.mode === "pulls" && this.pullsLayout.canReuseFiles(route.number),
    });
    this.updateChrome();
    if (!this.isCurrentActivation(options.activationGeneration)) {
      return null;
    }
    if (!route.path) {
      this.pullsLayout.showFilesList();
      this.updateChrome();
      return files;
    }
    const fullPath = options.resolvePath
      ? options.resolvePath(route.path)
      : route.path;
    if (!fullPath) {
      return null;
    }
    const file = this.pullsLayout.findFile(fullPath);
    const diff = await this.pullsLayout.openFile(
      fullPath,
      file?.status ?? options.status ?? "",
    );
    this.updateChrome();
    return diff;
  }

  private isCurrentActivation(generation: number | undefined) {
    return (
      this.active &&
      (generation === undefined || generation === this.activationGeneration)
    );
  }

  private routeForWorkspaceBack(): GithubRoute | null {
    if (this.mode === "issues" && this.issuesLayout.view === "detail") {
      return { kind: "issues", page: this.issuesLayout.page };
    }
    if (this.mode === "pulls" && this.pullsLayout.view === "detail") {
      return { kind: "pulls", page: this.pullsLayout.page };
    }
    if (this.mode === "pulls" && this.pullsLayout.view === "files") {
      const number = this.pullsLayout.currentPullNumber();
      return number
        ? { kind: "pulls", page: this.pullsLayout.page, number }
        : null;
    }
    return null;
  }

  private goBack() {
    const route = this.routeForWorkspaceBack();
    if (route) {
      this.requestGithubRoute(route);
    }
  }

  private openIssue(event: CustomEvent<{ number: number }>) {
    event.stopPropagation();
    this.requestGithubRoute({
      kind: "issues",
      page: this.issuesLayout.page,
      number: event.detail.number,
    });
  }

  private changeIssuesPage(event: CustomEvent<{ page: number }>) {
    event.stopPropagation();
    this.requestGithubRoute({ kind: "issues", page: event.detail.page });
  }

  private openPull(event: CustomEvent<{ number: number }>) {
    event.stopPropagation();
    this.requestGithubRoute({
      kind: "pulls",
      page: this.pullsLayout.page,
      number: event.detail.number,
    });
  }

  private changePullsPage(event: CustomEvent<{ page: number }>) {
    event.stopPropagation();
    this.requestGithubRoute({ kind: "pulls", page: event.detail.page });
  }

  private openPullFiles(event: CustomEvent<{ number: number }>) {
    event.stopPropagation();
    this.requestGithubRoute({
      kind: "pulls",
      page: this.pullsLayout.page,
      number: event.detail.number,
      files: true,
      path: "",
    });
  }

  private openPullFile(event: CustomEvent<{ path: string; status: string }>) {
    event.stopPropagation();
    const number = this.pullsLayout.currentPullNumber();
    if (!number) {
      return;
    }
    this.requestGithubRoute(
      {
        kind: "pulls",
        page: this.pullsLayout.page,
        number,
        files: true,
        path: event.detail.path,
      },
      { status: event.detail.status },
    );
  }

  private closePullFile(event: Event) {
    event.stopPropagation();
    const number = this.pullsLayout.currentPullNumber();
    if (!number) {
      return;
    }
    this.requestGithubRoute({
      kind: "pulls",
      page: this.pullsLayout.page,
      number,
      files: true,
      path: "",
    });
  }

  private startTask(
    event: CustomEvent<TaskStartSource & { opener: HTMLElement | null }>,
  ) {
    event.stopPropagation();
    this.taskStartDialog.open({
      ...event.detail,
      repository: this.repository,
      composerSettings: this.composerSettings,
    });
  }

  private requestGithubRoute(
    route: GithubRoute,
    options: { status?: string } = {},
  ) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-github-route", {
        bubbles: true,
        detail: { route, options },
      }),
    );
  }

  private setMode(mode: GithubMode) {
    if (this.mode === mode) {
      return;
    }
    if (mode !== "pulls") {
      this.pullsLayout.deactivate();
    }
    this.mode = mode;
    this.dataset.githubMode = mode;
  }

  // Reads what the header shows from the open route's layout and draws it
  // before Detail reads the layout again.
  private updateChrome() {
    const mode = this.mode;
    const issues = this.issuesLayout;
    const pulls = this.pullsLayout;
    const pullsView = mode === "pulls" ? pulls.view : null;
    const fileOpen = pullsView === "files" && pulls.filesView === "viewer";
    const details =
      mode === "issues"
        ? issues.view === "detail"
          ? {
              title: "Issue",
              subtitle: issues.issueSubtitle(),
              backLabel: "Back to issues",
            }
          : { title: "Issues", subtitle: issues.issuesSubtitle() }
        : pullsView === "detail"
          ? {
              title: "PR",
              subtitle: pulls.pullSubtitle(),
              backLabel: "Back to pull requests",
            }
          : pullsView === "files"
            ? {
                title: "PR Files",
                subtitle: pulls.pullSubtitle(),
                backLabel: "Back to PR",
              }
            : pullsView === "list"
              ? { title: "Pull Requests", subtitle: pulls.pullsSubtitle() }
              : { title: "GitHub", subtitle: "" };
    this.chrome = {
      mode,
      title: details.title,
      subtitle: details.subtitle,
      backLabel: details.backLabel ?? "Back",
      backShown: Boolean(details.backLabel) && !fileOpen,
      parentKey: githubParentKey(this.routeForWorkspaceBack()),
    };
    this.dataset.mobileDetail =
      (mode === "issues" && issues.view === "detail") ||
      pullsView === "detail" ||
      fileOpen
        ? "true"
        : "false";
    this.performUpdate();
  }

  private scopeId() {
    return `github:${encodeURIComponent(
      this.repository?.rootPath || this.currentPath || "repository",
    )}`;
  }

  // The children are drawn the first time one is needed, which can be before
  // the layout is in the document.
  private get issuesLayout() {
    this.performUpdate();
    return this.issues.value as CaffoldGithubIssuesLayout;
  }

  private get pullsLayout() {
    this.performUpdate();
    return this.pulls.value as CaffoldGithubPullsLayout;
  }

  private get taskStartDialog() {
    this.performUpdate();
    return this.startDialog.value as CaffoldGithubTaskStartDialog;
  }
}

function githubParentKey(route: GithubRoute | null) {
  if (!route?.kind) {
    return "";
  }
  if (route.kind === "pulls" && route.number) {
    return `pull:${encodeURIComponent(route.number)}`;
  }
  return route.kind;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-github-layout": CaffoldTaskGithubLayout;
  }
}
