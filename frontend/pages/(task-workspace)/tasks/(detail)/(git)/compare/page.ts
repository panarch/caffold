import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, type ActionHintPull } from "#app/action-hints.js";
import type { ScrollSurfacePull } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/git-compare-browser.js";
import type { CaffoldGitCompareBrowser } from "#components/git-compare-browser.js";

export class CaffoldGitComparePage extends LitElement {
  private readonly browserElement = new DrawnRef<CaffoldGitCompareBrowser>(
    this,
  );

  createRenderRoot() {
    return this;
  }

  render() {
    return html`<caffold-git-compare-browser
      ${drawn(this.browserElement)}
      @caffold:git-compare-state-change=${this.followBrowser}
    ></caffold-git-compare-browser>`;
  }

  firstUpdated() {
    this.dataset.detailView = this.browser.detailView;
  }

  get repository() {
    return this.browser.repository;
  }

  get refsPayload() {
    return this.browser.refsPayload;
  }

  get baseRef() {
    return this.browser.baseRef;
  }

  get headRef() {
    return this.browser.headRef;
  }

  get detailView() {
    return this.browser.detailView;
  }

  reset() {
    this.browser.reset();
  }

  invalidateRequests() {
    this.browser.invalidateRequests();
  }

  setContext(options: Parameters<CaffoldGitCompareBrowser["setContext"]>[0]) {
    this.browser.setContext(options);
  }

  openCompare(options: Parameters<CaffoldGitCompareBrowser["openCompare"]>[0]) {
    return this.browser.openCompare(options);
  }

  openDiff(path: string, status: string) {
    return this.browser.openDiff(path, status);
  }

  refresh() {
    return this.browser.refresh();
  }

  setSelectedPath(path: string) {
    this.browser.setSelectedPath(path);
  }

  setEmpty() {
    this.browser.setEmpty();
  }

  deactivate() {
    this.browser.deactivate();
  }

  showList() {
    this.browser.showList();
  }

  fileForPath(path: string) {
    return this.browser.fileForPath(path);
  }

  setView(view: "list" | "viewer") {
    this.browser.setView(view);
  }

  sidePane() {
    return this.browser.sidePane();
  }

  actionHintScope({ scopeId = "git", clipRoots = [] }: ActionHintPull = {}) {
    return this.browser.actionHintScope({
      scopeId,
      actions: {
        file: ACTION_HINT_ACTION.FILE_OPEN,
        disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
        parent: ACTION_HINT_ACTION.PARENT,
        details: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
        refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        link: ACTION_HINT_ACTION.LINK_OPEN,
        separator: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      },
      clipRoots: [this, ...clipRoots],
    });
  }

  scrollSurfaceScope({
    scopeId = "git",
    clipRoots = [],
  }: ScrollSurfacePull = {}) {
    return this.browser.scrollSurfaceScope({
      scopeId,
      clipRoots: [this, ...clipRoots],
    });
  }

  keyboardNavigationContexts({ scopeId = "git" } = {}) {
    return this.browser.keyboardNavigationContexts({ scopeId });
  }

  private followBrowser() {
    this.dataset.detailView = this.browser.detailView;
  }

  // The browser is drawn the first time it is needed, which can be before the
  // page is in the document.
  private get browser() {
    this.performUpdate();
    return this.browserElement.value as CaffoldGitCompareBrowser;
  }
}

customElements.define("caffold-git-compare-page", CaffoldGitComparePage);
