import { routeDomain, routeMode, sectionDetailRoute } from "../../../../navigation-routes.js";
import { cleanLogicalPath } from "../task-format.js";
import "./(task)/layout.js";
import "./(git)/layout.js";
import "./(github)/layout.js";
import "./(review)/layout.js";
import "./components/git-menu.js";
import "./components/github-menu.js";
import "./components/detail-view-switch.js";
import "./(task)/components/summary.js";
import "./(section)/components/summary.js";
import "./(section)/layout.js";

const CLEAN_REVIEW_CACHE_LIMIT = 6;

class CaffoldDetailLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.subjectKind = "";
    this.section = null;
    this.sectionRoute = null;
    this.taskRoute = null;
    this.taskSnapshot = null;
    this.sectionActivationKey = "";
    this.sharedDomainContextKey = "";
    this.domainActivationPromise = null;
    this.reviewComponents = new Map();
    this.reviewLastUsed = new Map();
    this.reviewUseSequence = 0;
    this.activeReviewKey = "";
    this.transportAvailable = true;
    this.codexStatusSnapshot = null;
    this.innerHTML = `
      <div class="common-detail-shell">
        <header class="detail-layout-summary task-detail-summary">
          <caffold-task-detail-summary hidden></caffold-task-detail-summary>
          <caffold-section-detail-summary></caffold-section-detail-summary>
          <div class="detail-layout-actions">
            <caffold-detail-view-switch></caffold-detail-view-switch>
            <caffold-task-detail-git></caffold-task-detail-git>
            <caffold-task-detail-github></caffold-task-detail-github>
          </div>
        </header>
        <div class="detail-layout-body">
          <div class="detail-subject-slot">
            <caffold-task-detail hidden></caffold-task-detail>
            <caffold-section-detail hidden></caffold-section-detail>
          </div>
          <div class="detail-review-slot" hidden></div>
          <div class="detail-git-slot" hidden></div>
          <div class="detail-github-slot" hidden></div>
        </div>
      </div>
    `;
    this.addEventListener("caffold:task-subject-snapshot", (event) => {
      if (event.target !== this.taskDetail()) {
        return;
      }
      event.stopPropagation();
      this.taskSnapshot = event.detail ?? null;
      if (this.subjectKind === "task") {
        this.syncTaskPresentation();
        void this.activateSharedSurface();
      }
    });
    this.addEventListener("caffold:task-detail-summary-intent", (event) => {
      if (event.target !== this.taskSummary()) {
        return;
      }
      event.stopPropagation();
      if (event.detail?.type === "archive") {
        void this.taskDetail()?.archiveSelectedTask();
      }
    });
    this.addEventListener(
      "caffold:detail-view-switch-intent",
      (event) => this.handleViewIntent(event),
    );
    this.addEventListener(
      "caffold:task-detail-git-intent",
      (event) => this.handleGitMenuIntent(event),
    );
    this.addEventListener(
      "caffold:task-detail-github-intent",
      (event) => this.handleGithubMenuIntent(event),
    );
    this.addEventListener(
      "caffold:task-review-route-intent",
      (event) => this.handleReviewRouteIntent(event),
    );
    this.addEventListener(
      "caffold:request-git-route",
      (event) => this.handleGitRouteIntent(event),
    );
    this.addEventListener(
      "caffold:request-github-route",
      (event) => this.handleGithubRouteIntent(event),
    );
    this.addEventListener(
      "caffold:section-detail-intent",
      (event) => this.handleSectionDetailIntent(event),
    );
    this.addEventListener("caffold:change-compare-refs", (event) => {
      if (!this.gitLayout()?.contains(event.target)) {
        return;
      }
      event.stopPropagation();
      if (this.subjectKind === "section") {
        this.requestSectionRoute({
          ...this.sectionRoute,
          sectionSurface: "git",
          sectionTool: "compare",
          baseRef: event.detail?.baseRef ?? "",
          headRef: event.detail?.headRef ?? "",
          path: "",
        });
      } else {
        this.requestTaskRoute({
          kind: "compare",
          threadId: this.subjectIdentity().id,
          baseRef: event.detail?.baseRef ?? "",
          headRef: event.detail?.headRef ?? "",
          path: "",
        });
      }
    });
    this.addEventListener("caffold:refresh-git-review", (event) => {
      if (!this.gitLayout()?.contains(event.target)) {
        return;
      }
      event.stopPropagation();
      void this.gitLayout()?.refresh();
    });
    this.addEventListener("caffold:task-detail-transport-change", (event) => {
      if (event.target !== this.taskDetail()) {
        return;
      }
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:task-detail-transport-change", {
          bubbles: true,
          composed: true,
          detail: event.detail,
        }),
      );
    });
  }

  disconnectedCallback() {
    this.deactivate();
    this.disposeReviews();
    this.gitLayout()?.remove();
    this.githubLayout()?.remove();
  }

  prepare(threadId, options = {}) {
    this.ensureRendered();
    this.taskRoute = { ...(options.route ?? { kind: "tasks", threadId }) };
    this.activateSubject("task");
    const prepared = this.taskDetail()?.prepare(threadId, options);
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
    return prepared;
  }

  async open(threadId, options = {}) {
    this.ensureRendered();
    this.taskRoute = { ...(options.route ?? { kind: "tasks", threadId }) };
    this.activateSubject("task");
    const result = await this.taskDetail()?.open(threadId, options);
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
    await this.activateSharedSurface();
    return result;
  }

  adoptCreatedDetail(detail, submission) {
    this.ensureRendered();
    this.activateSubject("task");
    this.taskDetail()?.adoptCreatedDetail(detail, submission);
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
  }

  prepareSection(section, route) {
    this.ensureRendered();
    if (!section?.id) {
      this.deactivate();
      return false;
    }
    const contextChanged = !this.sectionContextMatches(section);
    if (contextChanged) {
      this.deactivateSectionSurfaces();
      this.sectionActivationKey = "";
    }
    this.section = { ...section };
    this.sectionRoute = sectionDetailRoute({
      ...route,
      sectionId: section.id,
    });
    this.activateSubject("section");
    this.sectionDetail()?.setSection(this.section);
    this.sectionDetail()?.setTransportAvailable(this.transportAvailable);
    this.sectionDetail()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
    this.syncSectionPresentation();
    return true;
  }

  async openSection(section, route) {
    if (!this.prepareSection(section, route)) {
      return null;
    }
    if (
      !this.section.repository &&
      this.sectionRoute?.sectionSurface !== "new"
    ) {
      this.requestSectionRoute(
        { sectionId: this.section.id },
        { replace: true },
      );
      return this.section;
    }
    await this.activateSectionSurface();
    return section;
  }

  sectionContextMatches(section) {
    return sectionContextKey(this.section) === sectionContextKey(section);
  }

  updateSection(section) {
    if (!this.sectionContextMatches(section)) {
      return false;
    }
    const previousSettings = JSON.stringify(this.section?.composerSettings ?? null);
    const nextSettings = JSON.stringify(section?.composerSettings ?? null);
    this.section = { ...section };
    if (previousSettings === nextSettings) {
      return false;
    }
    this.sectionDetail()?.setSection(this.section);
    this.githubLayout()?.setContext({
      composerSettings: this.section.composerSettings ?? null,
    });
    return true;
  }

  activateSubject(kind) {
    if (this.subjectKind === kind) {
      this.hidden = false;
      return;
    }
    if (this.subjectKind === "task") {
      this.taskDetail()?.deactivate();
      this.deactivateSharedChildren();
    } else if (this.subjectKind === "section") {
      this.deactivateSectionSurfaces();
      this.sectionDetail()?.clear();
      this.section = null;
    }
    this.subjectKind = kind;
    this.dataset.detailSubject = kind;
    this.hidden = false;
    this.taskSummary()?.toggleAttribute("hidden", kind !== "task");
    this.sectionSummary()?.toggleAttribute("hidden", kind !== "section");
    this.syncActivePresentation();
  }

  deactivate(options = {}) {
    if (!this.rendered) {
      return;
    }
    if (this.subjectKind === "task") {
      this.taskDetail()?.deactivate(options);
      this.deactivateSharedChildren();
    } else {
      this.deactivateSectionSurfaces();
      this.sectionDetail()?.clear();
      this.section = null;
    }
  }

  suspendForeground() {
    if (this.subjectKind === "task") {
      this.taskDetail()?.suspendForeground();
    }
  }

  recoverForeground() {
    return this.subjectKind === "task"
      ? this.taskDetail()?.recoverForeground()
      : null;
  }

  currentDetail() {
    return this.taskDetail()?.currentDetail() ?? null;
  }

  hasSelectedTaskDetail() {
    return this.subjectKind === "task" &&
      Boolean(this.taskDetail()?.hasSelectedTaskDetail());
  }

  hasSelectedDetail() {
    return this.subjectKind === "section"
      ? Boolean(this.section?.id)
      : this.hasSelectedTaskDetail();
  }

  selectedTaskContextPath() {
    return this.subjectKind === "task"
      ? this.taskDetail()?.selectedTaskContextPath() ?? ""
      : this.sectionDetail()?.selectedContextPath() ?? "";
  }

  newTaskContextPath() {
    return this.subjectKind === "task"
      ? this.taskDetail()?.newTaskContextPath() ?? ""
      : this.sectionDetail()?.selectedContextPath() ?? "";
  }

  get taskDetailView() {
    return this.subjectKind === "task"
      ? this.taskDetail()?.taskDetailView ?? "conversation"
      : this.sectionRoute?.sectionSurface ?? "new";
  }

  get streamState() {
    return this.subjectKind === "task"
      ? this.taskDetail()?.streamState
      : "inactive";
  }

  setTransportAvailable(available) {
    this.transportAvailable = Boolean(available);
    this.sectionDetail()?.setTransportAvailable(this.transportAvailable);
  }

  setCodexStatusSnapshot(snapshot) {
    this.codexStatusSnapshot = snapshot ?? null;
    this.sectionDetail()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
  }

  captureTaskSnapshot() {
    this.taskSnapshot = this.taskDetail()?.detailSnapshot?.() ?? this.taskSnapshot;
  }

  syncActivePresentation() {
    if (this.subjectKind === "task") {
      this.captureTaskSnapshot();
      this.syncTaskPresentation();
    } else if (this.subjectKind === "section") {
      this.syncSectionPresentation();
    }
  }

  syncTaskPresentation() {
    if (this.subjectKind !== "task") {
      return;
    }
    const snapshot = this.taskSnapshot ?? {};
    const task = snapshot.task ?? null;
    this.summaryHeader()?.toggleAttribute("hidden", !task);
    const repository = Boolean(task?.worktree?.rootPath);
    this.rebindSharedDomainContext();
    const surface = this.activeSurface();
    this.taskSummary()?.setSnapshot({
      task,
      transportState: snapshot.transportState ?? this.streamState ?? "idle",
      contextPath: snapshot.contextPath ?? this.selectedTaskContextPath(),
      archiveState: snapshot.archiveState,
    });
    this.viewSwitch()?.setSnapshot({
      label: "Task view",
      selected: surface === "review"
        ? this.taskRoute?.reviewScope === "branch" ? "branch" : "working"
        : surface,
      choices: repository
        ? [
            { id: "conversation", label: "Conversation" },
            { id: "working", label: "Working Tree" },
            {
              id: "branch",
              label: "Branch",
              title: `Compare with ${this.taskRoute?.baseRef || "the default branch"}`,
            },
          ]
        : [
            { id: "conversation", label: "Conversation" },
            { id: "review", label: "Review" },
          ],
    });
    this.gitMenu()?.setSnapshot({ available: repository });
    this.githubMenu()?.setSnapshot({ available: repository });
    this.applySurfaceVisibility(surface);
    this.taskDetail()?.reconcileVisibleSurface?.();
  }

  syncSectionPresentation() {
    if (this.subjectKind !== "section" || !this.section) {
      return;
    }
    const repository = Boolean(this.section.repository);
    this.rebindSharedDomainContext();
    const surface = this.sectionRoute?.sectionSurface ?? "new";
    this.summaryHeader()?.removeAttribute("hidden");
    this.sectionSummary()?.setSnapshot({ section: this.section });
    this.viewSwitch()?.setSnapshot({
      label: "Section view",
      selected: surface === "review"
        ? this.sectionRoute.reviewScope === "branch" ? "branch" : "working"
        : surface,
      choices: repository
        ? [
            { id: "new", label: "New Task" },
            { id: "working", label: "Working Tree" },
            {
              id: "branch",
              label: "Branch",
              title: `Compare with ${this.sectionRoute?.baseRef || "the default branch"}`,
            },
          ]
        : [{ id: "new", label: "New Task" }],
    });
    this.gitMenu()?.setSnapshot({ available: repository });
    this.githubMenu()?.setSnapshot({ available: repository });
    const subjectActive = surface === "new";
    this.applySurfaceVisibility(surface);
    if (subjectActive) {
      this.sectionDetail()?.activate();
    } else {
      this.sectionDetail()?.deactivate();
    }
  }

  async activateSectionSurface() {
    return await this.activateSharedSurface();
  }

  async activateSharedSurface() {
    this.syncActivePresentation();
    const surface = this.activeSurface();
    if (surface !== "review") {
      this.deactivateReview();
    }
    if (surface !== "git") {
      this.gitLayout()?.deactivate();
    }
    if (surface !== "github") {
      this.githubLayout()?.deactivate();
    }
    if (this.subjectKind === "task" && !this.taskSnapshot?.task) {
      return null;
    }
    if (surface === "review") {
      const review = this.ensureReview();
      if (!review) {
        return null;
      }
      review.setDetailContext({
        identity: this.subjectIdentity(),
        path: this.reviewRootPath(),
        repository: this.hasRepository() ? this.repositorySnapshot() : null,
        route: this.reviewContextRoute(),
      });
      return review;
    }
    if (!["git", "github"].includes(surface)) {
      this.sectionActivationKey = "";
      this.domainActivationPromise = null;
      return null;
    }
    const child = surface === "git" ? this.ensureGitLayout() : this.ensureGithubLayout();
    const route = this.domainContextRoute();
    const identity = this.subjectIdentity();
    const rootPath = this.repositoryRootPath();
    if (!identity.id || !this.hasRepository() || !rootPath) {
      child.deactivate?.();
      child.reset?.();
      child.prepareRoute(route);
      return child;
    }
    const key = JSON.stringify([
      identity.kind,
      identity.id,
      surface,
      route,
      rootPath,
    ]);
    if (key === this.sectionActivationKey && child.active) {
      return child;
    }
    if (key === this.sectionActivationKey && this.domainActivationPromise) {
      return await this.domainActivationPromise;
    }
    this.sectionActivationKey = key;
    child.prepareRoute(route);
    const activation = child.activate(route, {
      context: {
        path: rootPath,
        repository: this.repositorySnapshot(),
        composerSettings:
          this.subjectKind === "section"
            ? this.section?.composerSettings ?? null
            : null,
      },
      routeOptions: {
        resolvePath: (path) => joinLogicalPath(rootPath, path),
      },
    });
    this.domainActivationPromise = activation;
    try {
      return await activation;
    } finally {
      if (this.domainActivationPromise === activation) {
        this.domainActivationPromise = null;
      }
    }
  }

  applySurfaceVisibility(surface) {
    const subjectSurface = this.subjectKind === "task" ? "conversation" : "new";
    const subjectActive = surface === subjectSurface;
    this.subjectSlot()?.toggleAttribute("hidden", !subjectActive);
    this.taskDetail()?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "task",
    );
    this.sectionDetail()?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "section",
    );
    this.reviewSlot()?.toggleAttribute("hidden", surface !== "review");
    this.gitSlot()?.toggleAttribute("hidden", surface !== "git");
    this.githubSlot()?.toggleAttribute("hidden", surface !== "github");
    if (!subjectActive && this.subjectKind === "task") {
      this.taskDetail()?.deactivateVisibleSurface?.();
    }
  }

  activeSurface() {
    if (this.subjectKind === "section") {
      return this.sectionRoute?.sectionSurface ?? "new";
    }
    const domain = routeDomain(this.taskRoute);
    return domain || (this.taskRoute?.review ? "review" : "conversation");
  }

  subjectIdentity() {
    return this.subjectKind === "section"
      ? { kind: "section", id: `${this.section?.id ?? ""}` }
      : {
          kind: "task",
          id: `${
            this.taskSnapshot?.task?.threadId ??
            this.taskSnapshot?.task?.id ??
            this.taskRoute?.threadId ??
            ""
          }`,
        };
  }

  rebindSharedDomainContext() {
    const identity = this.subjectIdentity();
    const key = JSON.stringify([
      identity.kind,
      identity.id,
      this.repositoryRootPath(),
      this.hasRepository(),
    ]);
    if (key === this.sharedDomainContextKey) {
      return false;
    }
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitLayout()?.reset();
    this.githubLayout()?.reset();
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
    this.sharedDomainContextKey = key;
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
    return true;
  }

  repositoryRootPath() {
    return cleanLogicalPath(
      this.subjectKind === "section"
        ? this.section?.name ?? ""
        : this.taskSnapshot?.task?.worktree?.rootPath ?? "",
    );
  }

  repositorySnapshot() {
    const rootPath = this.repositoryRootPath();
    return this.subjectKind === "section"
      ? { rootPath }
      : { ...(this.taskSnapshot?.task?.worktree ?? {}), rootPath };
  }

  hasRepository() {
    return this.subjectKind === "section"
      ? Boolean(this.section?.repository)
      : Boolean(this.taskSnapshot?.task?.worktree?.rootPath);
  }

  reviewRootPath() {
    return cleanLogicalPath(
      this.subjectKind === "section"
        ? this.section?.name ?? ""
        : this.taskSnapshot?.contextPath ??
          this.taskSnapshot?.task?.worktree?.rootPath ??
          this.taskSnapshot?.task?.cwdPath ??
          "",
    );
  }

  reviewContextRoute() {
    return this.subjectKind === "section"
      ? this.reviewTaskRoute()
      : this.taskRoute;
  }

  domainContextRoute() {
    return this.subjectKind === "section"
      ? this.domainTaskRoute()
      : this.taskRoute;
  }

  deactivateSectionSurfaces() {
    this.sectionDetail()?.deactivate();
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  deactivateSharedChildren() {
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  handleViewIntent(event) {
    if (event.target !== this.viewSwitch()) {
      return;
    }
    event.stopPropagation();
    const view = event.detail?.view;
    const preservedReviewRoute = this.reviewForSubject()?.currentTaskRoute?.();
    if (this.subjectKind === "section") {
      this.requestSectionRoute(
        view === "new"
          ? { sectionId: this.section.id }
          : {
              sectionId: this.section.id,
              sectionSurface: "review",
              ...reviewFields(preservedReviewRoute ?? this.sectionRoute),
              reviewScope: view === "branch" ? "branch" : "working",
            },
      );
      return;
    }
    const threadId = this.subjectIdentity().id;
    this.requestTaskRoute(
      view === "conversation"
        ? { kind: "tasks", threadId }
        : {
            ...(preservedReviewRoute ?? {}),
            kind: "tasks",
            threadId,
            review: true,
            reviewScope: view === "branch" ? "branch" : "working",
            reviewNavigator:
              preservedReviewRoute?.reviewNavigator ??
              (this.taskSnapshot?.task?.worktree ? "changes" : "files"),
            reviewViewer:
              preservedReviewRoute?.reviewViewer ??
              (this.taskSnapshot?.task?.worktree ? "diff" : "source"),
            path: preservedReviewRoute?.path ?? "",
            baseRef: preservedReviewRoute?.baseRef ?? "",
          },
    );
  }

  handleGitMenuIntent(event) {
    if (event.target !== this.gitMenu()) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: this.section.id,
        sectionSurface: "git",
        sectionTool: event.detail?.reviewKind,
      });
    } else {
      this.requestTaskRoute({
        kind: event.detail?.reviewKind,
        threadId: this.subjectIdentity().id,
        baseRef: "",
        headRef: "",
        page: 1,
        sha: "",
        path: "",
      });
    }
  }

  handleGithubMenuIntent(event) {
    if (event.target !== this.githubMenu()) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: this.section.id,
        sectionSurface: "github",
        sectionTool: event.detail?.reviewKind,
      });
    } else {
      this.requestTaskRoute({
        kind: event.detail?.reviewKind,
        threadId: this.subjectIdentity().id,
        page: 1,
        number: null,
        files: false,
        path: "",
      });
    }
  }

  handleReviewRouteIntent(event) {
    if (event.target !== this.review()) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: this.section.id,
        sectionSurface: "review",
        ...reviewFields(event.detail?.route),
      }, { replace: event.detail?.replace });
    } else {
      this.requestTaskRoute(event.detail?.route, {
        replace: event.detail?.replace,
      });
    }
  }

  handleGitRouteIntent(event) {
    if (!this.gitLayout()?.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: this.section.id,
        sectionSurface: "git",
        sectionTool: event.detail?.route?.kind,
        ...domainFields(event.detail?.route),
      }, event.detail?.options);
    } else {
      this.requestTaskDomainRoute(event.detail?.route, event.detail?.options);
    }
  }

  handleGithubRouteIntent(event) {
    if (!this.githubLayout()?.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: this.section.id,
        sectionSurface: "github",
        sectionTool: event.detail?.route?.kind,
        ...domainFields(event.detail?.route),
      }, event.detail?.options);
    } else {
      this.requestTaskDomainRoute(event.detail?.route, event.detail?.options);
    }
  }

  handleSectionDetailIntent(event) {
    if (
      !this.sectionDetail()?.contains(event.target) ||
      event.detail?.type !== "open-github" ||
      !["issues", "pulls"].includes(event.detail?.kind)
    ) {
      return;
    }
    event.stopPropagation();
    this.requestSectionRoute({
      sectionId: this.section?.id,
      sectionSurface: "github",
      sectionTool: event.detail.kind,
    });
  }

  requestTaskDomainRoute(route, options = {}) {
    if (!route) {
      return;
    }
    const rootPath = this.repositoryRootPath();
    this.requestTaskRoute({
      ...route,
      threadId: this.subjectIdentity().id,
      ...(route.path
        ? { path: taskRelativePath(rootPath, route.path) }
        : {}),
    }, options);
  }

  requestTaskRoute(route, options = {}) {
    if (!route || !this.subjectIdentity().id) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: routeDomain(route) ? "domain-route" : "review-route",
          route,
          replace: Boolean(options?.replace),
        },
      }),
    );
  }

  requestSectionRoute(route, options = {}) {
    const normalized = sectionDetailRoute(route);
    if (!normalized) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: routeDomain(normalized) ? "domain-route" : "review-route",
          route: normalized,
          replace: Boolean(options?.replace),
        },
      }),
    );
  }

  reviewTaskRoute() {
    return {
      kind: "tasks",
      threadId: `section:${this.section?.id ?? ""}`,
      review: true,
      ...reviewFields(this.sectionRoute),
    };
  }

  domainTaskRoute() {
    return {
      kind: routeMode(this.sectionRoute),
      threadId: `section:${this.section?.id ?? ""}`,
      ...domainFields(this.sectionRoute),
    };
  }

  ensureReview() {
    const identity = this.subjectIdentity();
    const key = detailIdentityKey(identity);
    if (!key) {
      return null;
    }
    if (this.activeReviewKey && this.activeReviewKey !== key) {
      this.deactivateReview({ prune: false });
    }
    let review = this.reviewComponents.get(key);
    if (!review) {
      review = document.createElement("caffold-task-review");
      this.reviewComponents.set(key, review);
    }
    this.activeReviewKey = key;
    this.reviewLastUsed.set(key, ++this.reviewUseSequence);
    if (review.parentElement !== this.reviewSlot()) {
      this.reviewSlot().replaceChildren(review);
    }
    this.pruneReviewCache();
    return review;
  }

  reviewForSubject() {
    return this.reviewComponents.get(detailIdentityKey(this.subjectIdentity())) ?? null;
  }

  deactivateReview({ prune = true } = {}) {
    const key = this.activeReviewKey;
    if (!key) {
      return;
    }
    this.reviewComponents.get(key)?.remove();
    this.reviewLastUsed.set(key, ++this.reviewUseSequence);
    this.activeReviewKey = "";
    if (prune) {
      this.pruneReviewCache();
    }
  }

  pruneReviewCache() {
    const inactive = [...this.reviewComponents.keys()]
      .filter((key) => key !== this.activeReviewKey)
      .sort(
        (left, right) =>
          (this.reviewLastUsed.get(left) ?? 0) -
          (this.reviewLastUsed.get(right) ?? 0),
      );
    const excess = Math.max(
      0,
      this.reviewComponents.size - CLEAN_REVIEW_CACHE_LIMIT,
    );
    for (let index = 0; index < excess; index += 1) {
      const key = inactive[index];
      this.reviewComponents.get(key)?.remove();
      this.reviewComponents.delete(key);
      this.reviewLastUsed.delete(key);
    }
  }

  disposeReviews() {
    for (const review of this.reviewComponents.values()) {
      review.remove();
    }
    this.reviewComponents.clear();
    this.reviewLastUsed.clear();
    this.reviewUseSequence = 0;
    this.activeReviewKey = "";
  }

  ensureGitLayout() {
    let layout = this.gitLayout();
    if (!layout) {
      layout = document.createElement("caffold-task-git-layout");
      this.gitSlot().replaceChildren(layout);
    }
    return layout;
  }

  ensureGithubLayout() {
    let layout = this.githubLayout();
    if (!layout) {
      layout = document.createElement("caffold-task-github-layout");
      this.githubSlot().replaceChildren(layout);
    }
    return layout;
  }

  taskDetail() { return this.subjectSlot()?.querySelector(":scope > caffold-task-detail"); }
  taskSummary() { return this.querySelector("caffold-task-detail-summary"); }
  summaryHeader() { return this.querySelector(".detail-layout-summary"); }
  sectionShell() { return this.querySelector(":scope > .common-detail-shell"); }
  sectionSummary() { return this.querySelector("caffold-section-detail-summary"); }
  viewSwitch() { return this.querySelector("caffold-detail-view-switch"); }
  gitMenu() { return this.sectionShell()?.querySelector("caffold-task-detail-git"); }
  githubMenu() { return this.sectionShell()?.querySelector("caffold-task-detail-github"); }
  sectionDetail() { return this.querySelector("caffold-section-detail"); }
  subjectSlot() { return this.querySelector(".detail-subject-slot"); }
  reviewSlot() { return this.querySelector(".detail-review-slot"); }
  gitSlot() { return this.querySelector(".detail-git-slot"); }
  githubSlot() { return this.querySelector(".detail-github-slot"); }
  review() {
    return this.activeReviewKey
      ? this.reviewComponents.get(this.activeReviewKey) ?? null
      : null;
  }
  gitLayout() { return this.gitSlot()?.querySelector(":scope > caffold-task-git-layout"); }
  githubLayout() { return this.githubSlot()?.querySelector(":scope > caffold-task-github-layout"); }
}

if (!customElements.get("caffold-detail-layout")) {
  customElements.define("caffold-detail-layout", CaffoldDetailLayout);
}

function reviewFields(route = {}) {
  return {
    reviewScope: route.reviewScope === "branch" ? "branch" : "working",
    reviewNavigator: route.reviewNavigator === "files" ? "files" : "changes",
    reviewViewer: route.reviewViewer === "source" ? "source" : "diff",
    path: `${route.path ?? ""}`,
    line: route.line ?? null,
    baseRef: `${route.baseRef ?? ""}`,
  };
}

function detailIdentityKey(identity = {}) {
  const kind = `${identity.kind ?? ""}`.trim();
  const id = `${identity.id ?? ""}`.trim();
  return kind && id ? `${kind}:${id}` : "";
}

function sectionContextKey(section) {
  const id = `${section?.id ?? ""}`;
  if (!id) {
    return "";
  }
  return JSON.stringify([
    id,
    cleanLogicalPath(section?.name ?? ""),
    Boolean(section?.repository),
  ]);
}

function domainFields(route = {}) {
  return {
    baseRef: `${route.baseRef ?? ""}`,
    headRef: `${route.headRef ?? ""}`,
    page: route.page ?? 1,
    sha: `${route.sha ?? ""}`,
    number: route.number ?? null,
    files: Boolean(route.files),
    path: `${route.path ?? ""}`,
  };
}

function joinLogicalPath(root, path) {
  const base = cleanLogicalPath(root);
  const relative = cleanLogicalPath(path);
  return relative && relative !== "."
    ? cleanLogicalPath(`${base}/${relative}`)
    : base;
}

function taskRelativePath(rootPath, path) {
  const root = cleanLogicalPath(rootPath);
  const target = cleanLogicalPath(path);
  if (!root || root === "." || target === root) {
    return target === root ? "" : target;
  }
  const prefix = `${root}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}
