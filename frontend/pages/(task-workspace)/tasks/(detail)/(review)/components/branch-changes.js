import { getGitCompare, getGitCompareDiff, getGitRefs } from "#app/api.js";
import "#components/git-compare-tree.js";
import { ChangesReading } from "../changes-reading.js";

class CaffoldReviewBranchChanges extends HTMLElement {
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
    this.baseRef = "";
    this.shown = false;
    this.refs = null;
    this.compare = null;
    this.error = null;
    this.reading = new ChangesReading();
    this.listShows = "";
    this.generation = 0;
    this.selectedPath = "";

    this.innerHTML = `<caffold-git-compare-tree></caffold-git-compare-tree>`;

    this.addEventListener("caffold:select-compare-base", (event) => {
      event.stopPropagation();
      this.selectBase(event.detail?.baseRef);
    });
  }

  setContext({ rootPath = "", branch = null, baseRef = "" } = {}) {
    this.ensureRendered();
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
      this.tree()?.reset();
      return;
    }
    if (baseRef !== this.baseRef) {
      this.baseRef = baseRef;
      this.compare = null;
      this.error = null;
      this.reading.reset();
    }
  }

  setShown(shown) {
    this.ensureRendered();
    this.shown = Boolean(shown);
  }

  // Git may have changed while the page was away or Review was hidden, so
  // the refs and comparison held are outdated until a request sent after
  // this point answers.
  markOutdated() {
    this.ensureRendered();
    this.reading.markReturned();
    this.generation += 1;
    this.showReadingState();
  }

  forgetRefs() {
    this.ensureRendered();
    this.refs = null;
  }

  async read({ force = false } = {}) {
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
      this.tree()?.setBaseSelection({ refs: refs.refs, value: baseRef });
      if (this.baseRef !== baseRef) {
        this.requestBase(baseRef);
        return null;
      }
      if (!this.compare) {
        this.tree()?.setLoading(refs.repository, {
          baseRef,
          headRef: this.headRef(refs),
        });
        this.listShows = "loading";
      }
      const compare = await getGitCompare(rootPath, baseRef, this.headRef(refs));
      if (!this.acceptsRead(generation, rootPath)) {
        return null;
      }
      const { accepted, previous } = this.reading.succeed();
      if (!accepted) {
        return null;
      }
      this.compare = compare;
      this.error = null;
      this.tree()?.setEmptyMessage(
        `No changes compared with ${baseRef || "the selected base"}.`,
      );
      if (previous.hasData) {
        this.tree()?.updateCompare(compare);
      } else {
        this.tree()?.setCompare(compare);
      }
      this.listShows = "data";
      this.tree()?.setSelectedPath(this.selectedPath);
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
      this.error = error;
      this.showReadingState();
      this.announceRead({ ok: false, error });
      return null;
    }
  }

  snapshot() {
    this.ensureRendered();
    const { fromBeforeReturn, failed } = this.reading.state;
    return {
      data: this.compare,
      error: this.error,
      outdated: fromBeforeReturn,
      failed,
      hasRefs: Boolean(this.refs),
    };
  }

  change(path) {
    const file = (this.compare?.files ?? []).find((entry) => entry.path === path);
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
    return getGitCompareDiff(this.rootPath, this.baseRef, this.headRef(), path);
  }

  diffKind() {
    return `${this.baseRef}...${this.headRef()}`;
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

  actionHintScope(options = {}) {
    return this.tree()?.actionHintScope(options);
  }

  scrollSurfaceScope(options = {}) {
    return this.tree()?.scrollSurfaceScope(options);
  }

  selectBase(baseRef) {
    const next = `${baseRef ?? ""}`;
    if (
      !next ||
      next === this.baseRef ||
      !this.refs?.refs?.some((ref) => ref.name === next)
    ) {
      return;
    }
    this.requestBase(next);
  }

  requestBase(baseRef) {
    this.dispatchEvent(
      new CustomEvent("caffold:review-base-intent", {
        bubbles: true,
        detail: { baseRef },
      }),
    );
  }

  headRef(refs = this.refs) {
    return this.branch || refs?.defaultHeadRef || "HEAD";
  }

  acceptsRead(generation, rootPath) {
    return (
      this.isConnected &&
      this.shown &&
      generation === this.generation &&
      rootPath === this.rootPath
    );
  }

  announceRead(detail) {
    this.dispatchEvent(
      new CustomEvent("caffold:review-changes-read", { bubbles: true, detail }),
    );
  }

  // The list shows the read's error where it holds no comparison, and loading
  // or the read's error where it holds only a comparison from before the page
  // came back that lists no changes. It is drawn again only when that choice
  // changes. A first comparison shows loading once the refs name its base.
  showReadingState() {
    const { hasData, fromBeforeReturn, reading, failed } = this.reading.state;
    const hidesData =
      !hasData || (fromBeforeReturn && !this.compare?.files?.length);
    const shows = !hidesData
      ? "data"
      : !hasData
        ? failed ? "error" : this.listShows
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
      this.tree()?.setLoading(repository, {
        baseRef: this.baseRef,
        headRef: this.headRef(),
      });
    } else if (shows === "error") {
      this.tree()?.setError(this.error, repository);
    } else if (shows === "data") {
      this.tree()?.updateCompare(this.compare);
    }
  }

  tree() {
    return this.querySelector(":scope > caffold-git-compare-tree");
  }
}

if (!customElements.get("caffold-review-branch-changes")) {
  customElements.define("caffold-review-branch-changes", CaffoldReviewBranchChanges);
}

function selectedCompareBaseRef(preferredRef, refsPayload = {}) {
  const refs = Array.isArray(refsPayload.refs) ? refsPayload.refs : [];
  const hasRef = (candidate) =>
    Boolean(candidate && refs.some((ref) => ref.name === candidate));
  if (hasRef(preferredRef)) {
    return `${preferredRef}`;
  }
  if (hasRef(refsPayload.defaultBaseRef)) {
    return `${refsPayload.defaultBaseRef}`;
  }
  return refs[0]?.name || refsPayload.defaultBaseRef || "";
}
