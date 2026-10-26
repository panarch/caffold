import { html, LitElement } from "lit";
import type { ActionHintPull } from "#app/action-hints.ts";
import {
  type GitCompare,
  type GitRefs,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
} from "#app/api.ts";
import type { ScrollSurfacePull } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "#components/git-compare-tree.ts";
import type { CaffoldGitCompareTree } from "#components/git-compare-tree.ts";
import { ChangesReading } from "../changes-reading.ts";
import type { ReviewChange } from "./selected-file/content.ts";

export class CaffoldReviewBranchChanges extends LitElement {
  private rootPath = "";
  private branch: string | null = null;
  private baseRef = "";
  private shown = false;
  private refs: GitRefs | null = null;
  private compare: GitCompare | null = null;
  private error: Error | null = null;
  private readonly reading = new ChangesReading();
  private readonly treeElement = new DrawnRef<CaffoldGitCompareTree>(this);
  private listShows = "";
  private generation = 0;
  private selectedPath = "";

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.generation += 1;
  }

  render() {
    return html`<caffold-git-compare-tree
      ${drawn(this.treeElement)}
      @caffold:select-compare-base=${this.chooseBase}
    ></caffold-git-compare-tree>`;
  }

  setContext({
    rootPath = "",
    branch = null,
    baseRef = "",
  }: {
    rootPath?: string;
    branch?: string | null;
    baseRef?: string;
  } = {}) {
    this.branch = branch;
    if (rootPath !== this.rootPath) {
      this.rootPath = rootPath;
      this.baseRef = baseRef;
      this.refs = null;
      this.compare = null;
      this.error = null;
      this.reading.reset();
      this.listShows = "";
      this.generation += 1;
      this.tree.reset();
      return;
    }
    if (baseRef !== this.baseRef) {
      this.baseRef = baseRef;
      this.compare = null;
      this.error = null;
      this.reading.reset();
    }
  }

  setShown(shown: boolean) {
    this.shown = shown;
  }

  // Git may have changed while the page was away or Review was hidden, so
  // the refs and comparison held are outdated until a request sent after
  // this point answers.
  markOutdated() {
    this.reading.markReturned();
    this.generation += 1;
    this.showReadingState();
  }

  forgetRefs() {
    this.refs = null;
  }

  async read({ force = false }: { force?: boolean } = {}) {
    const rootPath = this.rootPath;
    if (!rootPath) {
      return null;
    }
    const generation = ++this.generation;
    this.reading.start();
    this.showReadingState();
    try {
      const refs = force || !this.refs ? await getGitRefs(rootPath) : this.refs;
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      this.refs = refs;
      const baseRef = selectedCompareBaseRef(this.baseRef, refs);
      this.tree.setBaseSelection({ refs: refs.refs, value: baseRef });
      if (this.baseRef !== baseRef) {
        this.requestBase(baseRef);
        return null;
      }
      if (!this.compare) {
        this.tree.setLoading(refs.repository, {
          baseRef,
          headRef: this.headRef(refs),
        });
        this.listShows = "loading";
      }
      const compare = await getGitCompare(
        rootPath,
        baseRef,
        this.headRef(refs),
      );
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      const { accepted, previous } = this.reading.succeed();
      if (!accepted) {
        return null;
      }
      this.compare = compare;
      this.error = null;
      this.tree.setEmptyMessage(
        `No changes compared with ${baseRef || "the selected base"}.`,
      );
      if (previous.hasData) {
        this.tree.updateCompare(compare);
      } else {
        this.tree.setCompare(compare);
      }
      this.listShows = "data";
      this.tree.setSelectedPath(this.selectedPath);
      this.announceRead({
        ok: true,
        hadData: previous.hasData,
        wasOutdated: previous.fromBeforeReturn,
      });
      return compare;
    } catch (error) {
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      if (!this.reading.fail().accepted) {
        return null;
      }
      this.error = error as Error;
      this.showReadingState();
      this.announceRead({ ok: false, error });
      return null;
    }
  }

  snapshot() {
    const { fromBeforeReturn, failed } = this.reading.state;
    return {
      data: this.compare,
      error: this.error,
      outdated: fromBeforeReturn,
      failed,
      hasRefs: Boolean(this.refs),
    };
  }

  change(path: string): ReviewChange | null {
    const file = (this.compare?.files ?? []).find(
      (entry) => entry.path === path,
    );
    if (!file) {
      return null;
    }
    return {
      file,
      deleted: Boolean(file.status?.includes("D")),
      kind: "unstaged",
    };
  }

  readDiff(path: string) {
    return getGitCompareDiff(this.rootPath, this.baseRef, this.headRef(), path);
  }

  diffKind() {
    return `${this.baseRef}...${this.headRef()}`;
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
    return this.tree.actionHintScope(pull);
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.tree.scrollSurfaceScope(pull);
  }

  private chooseBase(event: CustomEvent<{ baseRef?: string }>) {
    event.stopPropagation();
    const next = `${event.detail?.baseRef ?? ""}`;
    if (
      !next ||
      next === this.baseRef ||
      !this.refs?.refs?.some((ref) => ref.name === next)
    ) {
      return;
    }
    this.requestBase(next);
  }

  private requestBase(baseRef: string) {
    this.dispatchEvent(
      new CustomEvent("caffold:review-base-intent", {
        bubbles: true,
        detail: { baseRef },
      }),
    );
  }

  private headRef(refs = this.refs) {
    return this.branch || refs?.defaultHeadRef || "HEAD";
  }

  private acceptsRead(generation: number, rootPath: string) {
    return (
      this.isConnected &&
      this.shown &&
      generation === this.generation &&
      rootPath === this.rootPath
    );
  }

  private announceRead(detail: Record<string, unknown>) {
    this.dispatchEvent(
      new CustomEvent("caffold:review-changes-read", { bubbles: true, detail }),
    );
  }

  // The list shows the read's error where it holds no comparison, and loading
  // or the read's error where it holds only a comparison from before the page
  // came back that lists no changes. It is drawn again only when that choice
  // changes. A first comparison shows loading once the refs name its base.
  private showReadingState() {
    const { hasData, fromBeforeReturn, reading, failed } = this.reading.state;
    const hidesData =
      !hasData || (fromBeforeReturn && !this.compare?.files?.length);
    const shows = !hidesData
      ? "data"
      : !hasData
        ? failed
          ? "error"
          : this.listShows
        : reading
          ? "loading"
          : failed
            ? "error"
            : "data";
    if (shows === this.listShows) {
      return;
    }
    this.listShows = shows;
    const repository = this.refs?.repository ?? null;
    if (shows === "loading") {
      this.tree.setLoading(repository, {
        baseRef: this.baseRef,
        headRef: this.headRef(),
      });
    } else if (shows === "error" && this.error) {
      this.tree.setError(this.error, repository);
    } else if (shows === "data" && this.compare) {
      this.tree.updateCompare(this.compare);
    }
  }

  // The tree is drawn the first time it is needed, which can be before the
  // changes are in the document.
  private get tree() {
    this.performUpdate();
    return this.treeElement.value as CaffoldGitCompareTree;
  }
}

customElements.define(
  "caffold-review-branch-changes",
  CaffoldReviewBranchChanges,
);

function selectedCompareBaseRef(preferredRef: string, refsPayload: GitRefs) {
  const refs = Array.isArray(refsPayload.refs) ? refsPayload.refs : [];
  const hasRef = (candidate: string | null | undefined) =>
    Boolean(candidate && refs.some((ref) => ref.name === candidate));
  if (hasRef(preferredRef)) {
    return preferredRef;
  }
  if (hasRef(refsPayload.defaultBaseRef)) {
    return `${refsPayload.defaultBaseRef}`;
  }
  return refs[0]?.name || refsPayload.defaultBaseRef || "";
}
