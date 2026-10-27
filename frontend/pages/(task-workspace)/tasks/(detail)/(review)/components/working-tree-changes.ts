import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { type GitStatus, getGitDiff, getGitStatus } from "#app/api.js";
import type { ScrollSurfacePull } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { ChangesReading } from "../changes-reading.js";
import type { ReviewChange } from "./selected-file/content.js";
import "./working-tree-changes/components/changes-tree.js";
import type { ChangesRead } from "../layout.js";
import type { CaffoldGitDiffChangesTree } from "./working-tree-changes/components/changes-tree.js";

@customElement("caffold-review-working-tree-changes")
export class CaffoldReviewWorkingTreeChanges extends LitElement {
  // A clean Working Tree offers the branch's changes instead.
  @state()
  private accessor branchActionShown = false;

  private rootPath = "";
  private branch: string | null = null;
  private status: GitStatus | null = null;
  private error: Error | null = null;
  private readonly reading = new ChangesReading();
  private readonly hints = new ActionHints(this);
  private readonly treeElement = new DrawnRef<CaffoldGitDiffChangesTree>(this);
  private listShows = "";
  private generation = 0;
  private selectedPath = "";

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
  }

  override render() {
    return html`
      <caffold-git-diff-changes-tree
        ${drawn(this.treeElement)}
      ></caffold-git-diff-changes-tree>
      <div
        class="working-tree-changes-empty-action"
        ?hidden=${!this.branchActionShown}
      >
        <p>Review committed changes against the branch base.</p>
        <button
          ${this.hints.button({
            id: "branch",
            label: "Review branch changes",
            role: "branch",
          })}
          type="button"
          class="task-secondary-button"
          data-review-action="review-branch"
          @click=${this.reviewBranch}
        >Review branch changes</button>
      </div>
    `;
  }

  setContext({
    rootPath = "",
    branch = null,
  }: {
    rootPath?: string;
    branch?: string | null;
  } = {}) {
    this.branch = branch;
    if (rootPath === this.rootPath) {
      return;
    }
    this.rootPath = rootPath;
    this.status = null;
    this.error = null;
    this.reading.reset();
    this.listShows = "";
    this.generation += 1;
    this.tree.reset();
    this.showBranchAction();
  }

  // Git may have changed while the page was away or Review was hidden, so
  // the status held is outdated until a request sent after this point answers.
  markOutdated() {
    this.reading.markReturned();
    this.generation += 1;
    this.showReadingState();
  }

  async read({ background = false }: { background?: boolean } = {}) {
    const rootPath = this.rootPath;
    if (!rootPath) {
      return null;
    }
    const generation = ++this.generation;
    this.reading.start();
    this.showReadingState();
    try {
      const status = await getGitStatus(rootPath);
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      const { accepted, previous } = this.reading.succeed();
      if (!accepted) {
        return null;
      }
      this.status = status;
      this.error = null;
      if (previous.hasData) {
        this.tree.updateStatus(status);
      } else {
        this.tree.setStatus(status);
      }
      this.listShows = "data";
      this.tree.setSelectedPath(this.selectedPath);
      this.showReadingState();
      this.announceRead({
        ok: true,
        hadData: previous.hasData,
        wasOutdated: previous.fromBeforeReturn,
        background,
      });
      return status;
    } catch (error) {
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      if (!this.reading.fail().accepted) {
        return null;
      }
      this.error = error as Error;
      this.showReadingState();
      this.announceRead({ ok: false, error, background });
      return null;
    }
  }

  snapshot() {
    const { fromBeforeReturn, failed } = this.reading.state;
    return {
      data: this.status,
      error: this.error,
      outdated: fromBeforeReturn,
      failed,
    };
  }

  change(path: string): ReviewChange | null {
    const file = (this.status?.files ?? []).find(
      (entry) => entry.path === path,
    );
    if (!file) {
      return null;
    }
    return {
      file,
      deleted: file.status.includes("D"),
      kind: file.untracked ? "untracked" : file.category || "unstaged",
    };
  }

  readDiff(path: string) {
    return getGitDiff(this.rootPath, path, this.change(path)?.kind);
  }

  diffKind() {
    return "";
  }

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.tree.setSelectedPath(this.selectedPath);
  }

  captureListScroll() {
    return this.tree.captureListScroll();
  }

  restoreListScroll(scroll: { top: number; left: number } | null | undefined) {
    this.tree.restoreListScroll(scroll);
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.tree.actionHintScope(pull),
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.tree.scrollSurfaceScope(pull);
  }

  private reviewBranch(event: Event) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:review-branch-intent", { bubbles: true }),
    );
  }

  private acceptsRead(generation: number, rootPath: string) {
    return (
      this.isConnected &&
      generation === this.generation &&
      rootPath === this.rootPath
    );
  }

  private announceRead(detail: ChangesRead) {
    this.dispatchEvent(
      new CustomEvent<ChangesRead>("caffold:review-changes-read", {
        bubbles: true,
        detail,
      }),
    );
  }

  // The list shows loading or the read's error where it holds no status, or
  // only status from before the page came back that lists no changes. It is
  // drawn again only when that choice changes.
  private showReadingState() {
    const { hasData, fromBeforeReturn, reading, failed } = this.reading.state;
    const hidesData =
      !hasData || (fromBeforeReturn && !this.status?.files?.length);
    const shows = !hidesData
      ? "data"
      : reading
        ? "loading"
        : failed
          ? "error"
          : hasData
            ? "data"
            : this.listShows;
    if (shows !== this.listShows) {
      this.listShows = shows;
      if (shows === "loading") {
        this.tree.setLoading({ rootPath: this.rootPath, branch: this.branch });
      } else if (shows === "error" && this.error) {
        this.tree.setError(this.error, { rootPath: this.rootPath });
      } else if (shows === "data" && this.status) {
        this.tree.updateStatus(this.status);
      }
    }
    this.showBranchAction();
  }

  private showBranchAction() {
    const { hasData, fromBeforeReturn } = this.reading.state;
    this.branchActionShown =
      hasData && !fromBeforeReturn && !this.status?.files?.length;
  }

  // The tree is drawn the first time it is needed, which can be before the
  // changes are in the document.
  private get tree() {
    this.performUpdate();
    return this.treeElement.value as CaffoldGitDiffChangesTree;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-review-working-tree-changes": CaffoldReviewWorkingTreeChanges;
  }
}
