import { html, LitElement } from "lit";
import type { ActionHintScopeOptions } from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { ScrollSurfaceScopeOptions } from "#app/scroll-scope.js";
import "#components/git-compare-browser.ts";
import type { CaffoldGitCompareBrowser } from "#components/git-compare-browser.ts";

export class CaffoldGitComparePage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`<caffold-git-compare-browser
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

  actionHintScope({
    scopeId = "git",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    return this.browser.actionHintScope({
      scopeId,
      fileActionId: ACTION_HINT_ACTION.FILE_OPEN,
      disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
      parentActionId: ACTION_HINT_ACTION.PARENT,
      detailsActionId: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
      refreshActionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
      separatorActionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this, ...clipRoots],
    });
  }

  scrollSurfaceScope({
    scopeId = "git",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}) {
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
    return this.querySelector(
      ":scope > caffold-git-compare-browser",
    ) as CaffoldGitCompareBrowser;
  }
}

customElements.define("caffold-git-compare-page", CaffoldGitComparePage);
