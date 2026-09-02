import "../../../../../../components/git-compare-browser.js";
import { ACTION_HINT_ACTION } from "../../../../action-hints.js";

class CaffoldGitComparePage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `<caffold-git-compare-browser></caffold-git-compare-browser>`;
    this.browser = this.querySelector("caffold-git-compare-browser");
    this.browser.ensureRendered();
    this.dataset.detailView = this.browser.detailView;
    this.browser.addEventListener("caffold:git-compare-state-change", () => {
      this.dataset.detailView = this.browser.detailView;
    });
  }

  get repository() {
    return this.browser?.repository ?? null;
  }

  get refsPayload() {
    return this.browser?.refsPayload ?? null;
  }

  get compare() {
    return this.browser?.compare ?? null;
  }

  get baseRef() {
    return this.browser?.baseRef ?? null;
  }

  get headRef() {
    return this.browser?.headRef ?? null;
  }

  get detailView() {
    return this.browser?.detailView ?? "list";
  }

  reset() {
    this.ensureRendered();
    return this.browser.reset();
  }

  invalidateRequests() {
    this.ensureRendered();
    return this.browser.invalidateRequests();
  }

  setContext(options) {
    this.ensureRendered();
    return this.browser.setContext(options);
  }

  openCompare(options) {
    this.ensureRendered();
    return this.browser.openCompare(options);
  }

  changeRefs(baseRef, headRef) {
    this.ensureRendered();
    return this.browser.changeRefs(baseRef, headRef);
  }

  openDiff(path, status) {
    this.ensureRendered();
    return this.browser.openDiff(path, status);
  }

  refresh() {
    this.ensureRendered();
    return this.browser.refresh();
  }

  setLoading(repository) {
    this.ensureRendered();
    return this.browser.setLoading(repository);
  }

  setCompare(compare) {
    this.ensureRendered();
    return this.browser.setCompare(compare);
  }

  setError(error, repository) {
    this.ensureRendered();
    return this.browser.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    return this.browser.setSelectedPath(path);
  }

  setEmpty() {
    this.ensureRendered();
    return this.browser.setEmpty();
  }

  deactivate() {
    this.ensureRendered();
    return this.browser.deactivate();
  }

  showList() {
    this.ensureRendered();
    return this.browser.showList();
  }

  hasCompare(baseRef, headRef) {
    this.ensureRendered();
    return this.browser.hasCompare(baseRef, headRef);
  }

  fileForPath(path) {
    this.ensureRendered();
    return this.browser.fileForPath(path);
  }

  isFileViewer(target) {
    this.ensureRendered();
    return this.browser.isFileViewer(target);
  }

  compareSubtitle(fallback) {
    this.ensureRendered();
    return this.browser.compareSubtitle(fallback);
  }

  setView(view) {
    this.ensureRendered();
    return this.browser.setView(view);
  }

  actionHintScope({ scopeId = "git", clipRoots = [] } = {}) {
    this.ensureRendered();
    return this.browser.actionHintScope({
      scopeId,
      fileActionId: ACTION_HINT_ACTION.FILE_OPEN,
      disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
      parentActionId: ACTION_HINT_ACTION.PARENT,
      detailsActionId: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
      refreshActionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      clipRoots: [this, ...clipRoots],
    });
  }

  scrollSurfaceScope({ scopeId = "git", clipRoots = [] } = {}) {
    this.ensureRendered();
    return this.browser.scrollSurfaceScope({
      scopeId,
      clipRoots: [this, ...clipRoots],
    });
  }

  keyboardNavigationContexts({ scopeId = "git" } = {}) {
    this.ensureRendered();
    return this.browser.keyboardNavigationContexts({
      scopeId,
    });
  }
}

customElements.define("caffold-git-compare-page", CaffoldGitComparePage);
