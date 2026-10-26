import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import type { TaskStoreStatusSnapshot } from "../../task-store-status.ts";
import "../components/task-create.ts";
import type { ServerPaths } from "../components/task-create/directory-path.ts";
import type {
  CaffoldTaskCreate,
  TaskCreateIntentDetail,
} from "../components/task-create.ts";
import { cleanLogicalPath } from "../task-format.ts";

const GUIDE_INTRO =
  "Start with a setup-only request when you want this task separated from your main checkout. By default, Caffold prepares a clean worktree and leaves staged, unstaged, and untracked changes in your current checkout. The same setup request also works in an existing task.";
const PREPARE_REQUEST =
  "Prepare this task in an isolated worktree. Leave my current checkout changes in place. Stop when the worktree is ready.";
const MOVE_CHANGES_NOTE =
  "Need the current changes too? Say “Move this task and my current changes into an isolated worktree.”";
const WORKSPACE = ":scope > .task-new-workspace";

/**
 * The New Task screen: where the Task works and what it is asked first, with
 * a guide to starting it in its own worktree.
 *
 * The Tasks screen hands it the directory, the server's paths, and whether
 * Tasks can be made now, and starts the Task its form asks for. A directory
 * chosen here becomes the screen's route.
 */
export class CaffoldTaskNew extends LitElement {
  private cwd = ".";
  private server: ServerPaths = {};
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.taskCreate()?.deactivate();
  }

  prepare({
    cwd = "",
    defaultCwdPath = "",
  }: {
    cwd?: string | null;
    defaultCwdPath?: string | null;
  } = {}) {
    this.cwd = cleanLogicalPath(cwd || defaultCwdPath || ".");
    this.syncTaskCreate();
  }

  open() {
    this.hidden = false;
    this.syncTaskCreate();
    this.taskCreate()?.activate();
  }

  deactivate() {
    this.taskCreate()?.deactivate();
    this.hidden = true;
  }

  setServerPaths(server: ServerPaths) {
    this.server = { ...server };
    this.taskCreate()?.setServerPaths(this.server);
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  selectedContextPath() {
    return cleanLogicalPath(this.cwd);
  }

  actionHintScope(): ActionHintScope {
    this.performUpdate();
    const scrollRoot = this.querySelector(WORKSPACE);
    return mergeActionHintScopes(
      this.taskCreate()?.actionHintScope({
        scopeId: "new",
        clipRoots: scrollRoot ? [this, scrollRoot] : [this],
      }),
      {
        blocked: false,
        targets: [],
        mutationRoots: [],
        scrollRoots: scrollRoot ? [scrollRoot] : [],
      },
    );
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    this.performUpdate();
    const scrollport = this.querySelector(WORKSPACE);
    const cwd = this.selectedContextPath();
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return mergeScrollSurfaceScopes(
      {
        blocked: false,
        surfaces: [
          {
            id: `new:${cwd}:scroll`,
            label: "New Task",
            scrollport,
            clipRoots: [this, scrollport],
            isEligible: () =>
              this.isConnected &&
              !this.hidden &&
              this.selectedContextPath() === cwd &&
              this.querySelector(WORKSPACE) === scrollport &&
              hasScrollLayoutBox(this) &&
              hasScrollLayoutBox(scrollport),
          },
        ],
        mutationRoots: [this],
        resizeElements: [this, scrollport],
        scrollRoots: [scrollport],
      },
      this.taskCreate()?.scrollSurfaceScope({
        scopeId: "new",
        clipRoots: [this, scrollport],
      }),
    );
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    if (this.hidden) {
      return [];
    }
    return (
      this.taskCreate()?.keyboardNavigationContexts({ scopeId: "new" }) ?? []
    );
  }

  ownsEditingEscape(element: Element | null) {
    return (
      !this.hidden && Boolean(this.taskCreate()?.ownsEditingEscape(element))
    );
  }

  render() {
    return html`
      <header class="task-new-header">
        <h2>New Task</h2>
      </header>
      <section class="task-new-workspace">
        <caffold-task-create
          @caffold:task-create-intent=${this.chooseCwd}
        ></caffold-task-create>
        <section
          class="task-new-worktree-guide"
          aria-labelledby="task-new-worktree-guide-title"
        >
          <h2 id="task-new-worktree-guide-title"
            >Work in an isolated worktree</h2>
          <p>${GUIDE_INTRO}</p>
          <ol>
            <li>
              <span class="task-new-worktree-label">Prepare the workspace</span>
              <code>${PREPARE_REQUEST}</code>
            </li>
            <li>
              <span class="task-new-worktree-label"
                >Continue in the worktree</span>
              <code>Now review PR #123.</code>
            </li>
          </ol>
          <p class="task-new-worktree-note">${MOVE_CHANGES_NOTE}</p>
        </section>
      </section>
    `;
  }

  // The form inside is told its directory and server as soon as it exists,
  // since the Tasks screen reads it right after.
  protected firstUpdated() {
    this.syncTaskCreate();
  }

  // A start request goes on to the Tasks screen, which makes the Task.
  private chooseCwd(event: CustomEvent<TaskCreateIntentDetail>) {
    const detail = event.detail;
    if (detail?.type !== "choose-cwd") {
      return;
    }
    event.stopPropagation();
    this.cwd = cleanLogicalPath(detail.path ?? "");
    this.syncTaskCreate();
    this.dispatchEvent(
      new CustomEvent("caffold:task-new-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route: { kind: "tasks", new: true, cwd: this.cwd } },
      }),
    );
  }

  private syncTaskCreate() {
    this.performUpdate();
    const taskCreate = this.taskCreate();
    if (!taskCreate) {
      return;
    }
    taskCreate.setContext({ cwd: this.selectedContextPath(), browseCwd: true });
    taskCreate.setServerPaths(this.server);
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  private taskCreate() {
    return this.querySelector<CaffoldTaskCreate>(
      ":scope > .task-new-workspace > caffold-task-create",
    );
  }
}

customElements.define("caffold-task-new", CaffoldTaskNew);
