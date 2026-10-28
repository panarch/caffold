import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type { TaskStoreStatusSnapshot } from "../../task-store-status.js";
import "../components/task-create.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { ParsedRoute } from "#app/navigation-routes.js";
import type { TaskCreateIntentDetail } from "../../task-create-intent-event.js";
import type { ServerPaths } from "../components/task-create/directory-path.js";
import type { CaffoldTaskCreate } from "../components/task-create.js";
import { cleanLogicalPath } from "../task-format.js";

import styles from "./page.css.js";

export interface TaskNewRouteIntentDetail {
  route: ParsedRoute;
}

const GUIDE_INTRO =
  "Start with a setup-only request when you want this task separated from your main checkout. By default, Caffold prepares a clean worktree and leaves staged, unstaged, and untracked changes in your current checkout. The same setup request also works in an existing task.";
const PREPARE_REQUEST =
  "Prepare this task in an isolated worktree. Leave my current checkout changes in place. Stop when the worktree is ready.";
const MOVE_CHANGES_NOTE =
  "Need the current changes too? Say “Move this task and my current changes into an isolated worktree.”";

/**
 * The New Task screen: where the Task works and what it is asked first, with
 * a guide to starting it in its own worktree.
 *
 * The Tasks screen hands it the directory, the server's paths, and whether
 * Tasks can be made now, and starts the Task its form asks for. A directory
 * chosen here becomes the screen's route.
 */
@customElement("caffold-task-new")
export class CaffoldTaskNew extends CaffoldElement {
  static override styles = styles;

  private cwd = ".";
  private server: ServerPaths = {};
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly workspace = new DrawnRef<HTMLElement>(this);
  private readonly create = new DrawnRef<CaffoldTaskCreate>(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.create.value?.deactivate();
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
    this.create.value?.activate();
  }

  deactivate() {
    this.create.value?.deactivate();
    this.hidden = true;
  }

  setServerPaths(server: ServerPaths) {
    this.server = { ...server };
    this.create.value?.setServerPaths(this.server);
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
    this.create.value?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.create.value?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  selectedContextPath() {
    return cleanLogicalPath(this.cwd);
  }

  actionHintScope() {
    const workspace = this.workspace.value;
    return mergeActionHintScopes(
      this.create.value?.actionHintScope({
        scopeId: "new",
        clipRoots: workspace ? [this, workspace] : [this],
      }),
      { scrollRoots: workspace ? [workspace] : [] },
    );
  }

  scrollSurfaceScope({ label = "New Task", ...pull }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, label });
    const workspace = this.workspace.value;
    return mergeScrollSurfaceScopes(
      own,
      workspace &&
        this.create.value?.scrollSurfaceScope({
          scopeId: "new",
          clipRoots: [this, workspace],
        }),
    );
  }

  keyboardNavigationContexts() {
    if (this.hidden) {
      return [];
    }
    return (
      this.create.value?.keyboardNavigationContexts({ scopeId: "new" }) ?? []
    );
  }

  ownsEditingEscape(element: Element | null) {
    return (
      !this.hidden && Boolean(this.create.value?.ownsEditingEscape(element))
    );
  }

  override render() {
    return html`
      <header class="task-new-header">
        <h2>New Task</h2>
      </header>
      <section
        ${drawn(this.workspace)}
        ${this.surfaces.surface({
          // A Surface for one directory does not carry over to the next.
          id: `new:${this.selectedContextPath()}:scroll`,
          clipRoots: () => [this, this.workspace.value],
        })}
        class="task-new-workspace"
      >
        <caffold-task-create
          ${drawn(this.create)}
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
  protected override firstUpdated() {
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
      new CustomEvent<TaskNewRouteIntentDetail>(
        "caffold:task-new-route-intent",
        {
          bubbles: true,
          composed: true,
          detail: { route: { kind: "tasks", new: true, cwd: this.cwd } },
        },
      ),
    );
  }

  private syncTaskCreate() {
    this.requestUpdate();
    this.performUpdate();
    const taskCreate = this.create.value;
    if (!taskCreate) {
      return;
    }
    taskCreate.setContext({ cwd: this.selectedContextPath(), browseCwd: true });
    taskCreate.setServerPaths(this.server);
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-new": CaffoldTaskNew;
  }

  interface HTMLElementEventMap {
    "caffold:task-new-route-intent": CustomEvent<TaskNewRouteIntentDetail>;
  }
}
