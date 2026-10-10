import { cleanLogicalPath } from "../task-format.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import "../components/task-create.js";

class CaffoldTaskNew extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("caffold:task-create-intent", this.boundCreateIntent);
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.removeEventListener(
      "caffold:task-create-intent",
      this.boundCreateIntent,
    );
    this.taskCreate()?.deactivate();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.cwd = ".";
    this.server = {};
    this.transportAvailable = true;
    this.taskStoreStatusSnapshot = null;
    this.boundCreateIntent = (event) => this.handleCreateIntent(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .task-new-workspace")) {
      return;
    }
    this.innerHTML = `
      <section class="task-new-workspace">
        <caffold-task-create></caffold-task-create>
        <section class="task-new-worktree-guide" aria-labelledby="task-new-worktree-guide-title">
          <h2 id="task-new-worktree-guide-title">Work in an isolated worktree</h2>
          <p>Start with a setup-only request when you want this task separated from your main checkout. By default, Caffold prepares a clean worktree and leaves staged, unstaged, and untracked changes in your current checkout. The same setup request also works in an existing task.</p>
          <ol>
            <li>
              <span class="task-new-worktree-label">Prepare the workspace</span>
              <code>Prepare this task in an isolated worktree. Leave my current checkout changes in place. Stop when the worktree is ready.</code>
            </li>
            <li>
              <span class="task-new-worktree-label">Continue in the worktree</span>
              <code>Now review PR #123.</code>
            </li>
          </ol>
          <p class="task-new-worktree-note">Need the current changes too? Say “Move this task and my current changes into an isolated worktree.”</p>
        </section>
      </section>
    `;
    this.syncTaskCreate();
  }

  prepare({ cwd = "", defaultCwdPath = "" } = {}) {
    this.ensureState();
    this.cwd = cleanLogicalPath(cwd || defaultCwdPath || ".");
    this.ensureRendered();
    this.syncTaskCreate();
  }

  open() {
    this.ensureState();
    this.hidden = false;
    this.syncTaskCreate();
    this.taskCreate()?.activate();
  }

  deactivate() {
    this.taskCreate()?.deactivate();
    this.hidden = true;
  }

  setServerPaths(server) {
    this.ensureState();
    this.server = { ...server };
    this.taskCreate()?.setServerPaths(this.server);
  }

  setTransportAvailable(available) {
    this.ensureState();
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot) {
    this.ensureState();
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  selectedContextPath() {
    this.ensureState();
    return cleanLogicalPath(this.cwd);
  }

  actionHintScope() {
    this.ensureRendered();
    const scrollRoot = this.querySelector(":scope > .task-new-workspace");
    return mergeActionHintScopes(
      this.taskCreate()?.actionHintScope({
        scopeId: "new",
        clipRoots: [this, scrollRoot].filter(Boolean),
      }),
      { targets: [], mutationRoots: [], scrollRoots: [scrollRoot].filter(Boolean) },
    );
  }

  scrollSurfaceScope() {
    this.ensureRendered();
    const scrollport = this.querySelector(":scope > .task-new-workspace");
    const cwd = this.selectedContextPath();
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    const page = {
      blocked: false,
      surfaces: [{
        id: `new:${cwd}:scroll`,
        label: "New Task",
        scrollport,
        clipRoots: [this, scrollport],
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.selectedContextPath() === cwd &&
          this.querySelector(":scope > .task-new-workspace") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
    return mergeScrollSurfaceScopes(
      page,
      this.taskCreate()?.scrollSurfaceScope({
        scopeId: "new",
        clipRoots: [this, scrollport],
      }),
    );
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    if (this.hidden) {
      return [];
    }
    return this.taskCreate()?.keyboardNavigationContexts({ scopeId: "new" }) ?? [];
  }

  ownsEditingEscape(element) {
    return !this.hidden && Boolean(this.taskCreate()?.ownsEditingEscape(element));
  }

  taskCreate() {
    return this.querySelector(
      ":scope > .task-new-workspace > caffold-task-create",
    );
  }

  handleCreateIntent(event) {
    if (
      event.target !== this.taskCreate() ||
      event.detail?.type !== "choose-cwd"
    ) {
      return;
    }
    event.stopPropagation();
    this.cwd = cleanLogicalPath(event.detail?.path ?? "");
    this.syncTaskCreate();
    this.dispatchRoute({ kind: "tasks", new: true, cwd: this.cwd });
  }

  syncTaskCreate() {
    const taskCreate = this.taskCreate();
    if (!taskCreate) {
      return;
    }
    taskCreate.setContext({ cwd: this.selectedContextPath(), browseCwd: true });
    taskCreate.setServerPaths(this.server);
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  dispatchRoute(route) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-new-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route },
      }),
    );
  }
}

if (!customElements.get("caffold-task-new")) {
  customElements.define("caffold-task-new", CaffoldTaskNew);
}
