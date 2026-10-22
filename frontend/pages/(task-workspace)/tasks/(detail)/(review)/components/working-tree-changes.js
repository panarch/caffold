import { getGitDiff, getGitStatus } from "#app/api.js";
import {
  buttonActionHintTarget,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { ChangesReading } from "../changes-reading.js";
import "./working-tree-changes/components/changes-tree.js";

const BRANCH_ACTION_SELECTOR =
  ':scope > .working-tree-changes-empty-action:not([hidden]) > button[data-review-action="review-branch"]';

class CaffoldReviewWorkingTreeChanges extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.generation += 1;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.rootPath = "";
    this.branch = null;
    this.status = null;
    this.error = null;
    this.reading = new ChangesReading();
    this.listShows = "";
    this.generation = 0;
    this.selectedPath = "";

    this.innerHTML = `
      <caffold-git-diff-changes-tree></caffold-git-diff-changes-tree>
      <div class="working-tree-changes-empty-action" hidden>
        <p>Review committed changes against the branch base.</p>
        <button type="button" class="task-secondary-button" data-review-action="review-branch">Review branch changes</button>
      </div>
    `;

    this.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-review-action="review-branch"]')
        : null;
      if (!button || !this.contains(button)) {
        return;
      }
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:review-branch-intent", { bubbles: true }),
      );
    });
  }

  setContext({ rootPath = "", branch = null } = {}) {
    this.ensureRendered();
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
    this.tree()?.reset();
    this.patchEmptyAction();
  }

  // Git may have changed while the page was away or Review was hidden, so
  // the status held is outdated until a request sent after this point answers.
  markOutdated() {
    this.ensureRendered();
    this.reading.markReturned();
    this.generation += 1;
    this.showReadingState();
  }

  async read({ background = false } = {}) {
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
        this.tree()?.updateStatus(status);
      } else {
        this.tree()?.setStatus(status);
      }
      this.listShows = "data";
      this.tree()?.setSelectedPath(this.selectedPath);
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
      this.error = error;
      this.showReadingState();
      this.announceRead({ ok: false, error, background });
      return null;
    }
  }

  snapshot() {
    this.ensureRendered();
    const { fromBeforeReturn, failed } = this.reading.state;
    return {
      data: this.status,
      error: this.error,
      outdated: fromBeforeReturn,
      failed,
    };
  }

  change(path) {
    const file = (this.status?.files ?? []).find((entry) => entry.path === path);
    if (!file) {
      return null;
    }
    return {
      file,
      deleted: `${file.status ?? ""}`.includes("D"),
      kind: file.untracked ? "untracked" : file.category || "unstaged",
    };
  }

  readDiff(path) {
    return getGitDiff(this.rootPath, path, this.change(path)?.kind);
  }

  diffKind() {
    return "";
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.selectedPath = path ?? "";
    this.tree()?.setSelectedPath(this.selectedPath);
  }

  captureListScroll() {
    return this.tree()?.captureListScroll() ?? null;
  }

  restoreListScroll(scroll) {
    this.tree()?.restoreListScroll(scroll);
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    branchTargetId = "",
    branchActionId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const branchControl = this.querySelector(BRANCH_ACTION_SELECTOR);
    const branchScope = branchControl && !branchControl.disabled
      ? {
          targets: [buttonActionHintTarget({
            invalidationOwner: this,
            id: branchTargetId,
            actionId: branchActionId,
            label: branchControl.textContent?.trim() || "Review branch changes",
            control: branchControl,
            clipRoots,
            isActionable: () =>
              this.isConnected &&
              isCurrent() &&
              this.querySelector(BRANCH_ACTION_SELECTOR) === branchControl &&
              !branchControl.disabled,
          })],
          mutationRoots: [branchControl.parentElement].filter(Boolean),
          scrollRoots: [],
        }
      : null;
    return mergeActionHintScopes(
      branchScope,
      this.tree()?.actionHintScope({
        scopeId,
        actionId,
        disclosureActionId,
        clipRoots,
      }),
    );
  }

  scrollSurfaceScope(options = {}) {
    return this.tree()?.scrollSurfaceScope(options);
  }

  acceptsRead(generation, rootPath) {
    return (
      this.isConnected &&
      generation === this.generation &&
      rootPath === this.rootPath
    );
  }

  announceRead(detail) {
    this.dispatchEvent(
      new CustomEvent("caffold:review-changes-read", { bubbles: true, detail }),
    );
  }

  // The list shows loading or the read's error where it holds no status, or
  // only status from before the page came back that lists no changes. It is
  // drawn again only when that choice changes.
  showReadingState() {
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
        this.tree()?.setLoading({ rootPath: this.rootPath, branch: this.branch });
      } else if (shows === "error") {
        this.tree()?.setError(this.error, { rootPath: this.rootPath });
      } else if (shows === "data") {
        this.tree()?.updateStatus(this.status);
      }
    }
    this.patchEmptyAction();
  }

  patchEmptyAction() {
    const { hasData, fromBeforeReturn } = this.reading.state;
    const empty = hasData && !fromBeforeReturn && !this.status?.files?.length;
    this.querySelector(":scope > .working-tree-changes-empty-action")
      ?.toggleAttribute("hidden", !empty);
  }

  tree() {
    return this.querySelector(":scope > caffold-git-diff-changes-tree");
  }
}

if (!customElements.get("caffold-review-working-tree-changes")) {
  customElements.define(
    "caffold-review-working-tree-changes",
    CaffoldReviewWorkingTreeChanges,
  );
}
