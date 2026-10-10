import "../../components/task-create.js";
import "./components/conversation-shortcuts.js";
import "./components/github-shortcuts.js";
import { cleanLogicalPath } from "../../task-format.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";

class CaffoldSectionDetail extends HTMLElement {
  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.section = null;
    this.server = {};
    this.transportAvailable = true;
    this.taskStoreStatusSnapshot = null;
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > caffold-task-create")) {
      return;
    }
    this.innerHTML = `
      <caffold-task-create></caffold-task-create>
      <caffold-section-conversation-shortcuts hidden></caffold-section-conversation-shortcuts>
      <caffold-section-github-shortcuts hidden></caffold-section-github-shortcuts>
    `;
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
  }

  setSection(section) {
    this.ensureRendered();
    const previousContext = this.sectionContextKey(this.section);
    const nextContext = this.sectionContextKey(section);
    if (previousContext && previousContext !== nextContext) {
      this.taskCreate()?.remove();
      this.prepend(document.createElement("caffold-task-create"));
    }
    this.section = section ? { ...section } : null;
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
  }

  activate() {
    this.ensureRendered();
    this.hidden = false;
    this.conversationShortcuts()?.activate();
    this.githubShortcuts()?.activate();
    this.taskCreate()?.activate();
  }

  deactivate() {
    this.conversationShortcuts()?.deactivate();
    this.githubShortcuts()?.deactivate();
    this.taskCreate()?.deactivate();
  }

  clear() {
    this.conversationShortcuts()?.deactivate();
    this.taskCreate()?.deactivate();
    this.replaceChildren();
    this.section = null;
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
    this.conversationShortcuts()?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot) {
    this.ensureState();
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
    this.conversationShortcuts()?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
  }

  selectedContextPath() {
    return `${this.section?.name ?? ""}`;
  }

  actionHintScope() {
    this.ensureRendered();
    const taskCreate = this.taskCreate();
    const sectionId = `${this.section?.id ?? ""}`;
    const scopeId = `section:${sectionId}`;
    return mergeActionHintScopes(
      sectionId
        ? taskCreate?.actionHintScope({ scopeId, clipRoots: [this] })
        : null,
      { targets: [], mutationRoots: [], scrollRoots: [this] },
      this.conversationShortcuts()?.actionHintScope({
        scopeId,
        clipRoots: [this],
      }),
      this.githubShortcuts()?.actionHintScope({
        scopeId,
        clipRoots: [this],
      }),
    );
  }

  scrollSurfaceScope() {
    this.ensureRendered();
    const sectionId = `${this.section?.id ?? ""}`;
    if (this.hidden || !sectionId) {
      return emptyScrollSurfaceScope();
    }
    const section = {
      blocked: false,
      surfaces: [{
        id: `section:${sectionId}:scroll`,
        label: this.section?.name
          ? `Section ${this.section.name}`
          : "Section",
        scrollport: this,
        clipRoots: [this],
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          `${this.section?.id ?? ""}` === sectionId &&
          hasScrollLayoutBox(this),
      }],
      mutationRoots: [this],
      resizeElements: [this],
      scrollRoots: [this],
    };
    return mergeScrollSurfaceScopes(
      section,
      this.taskCreate()?.scrollSurfaceScope({
        scopeId: `section:${sectionId}`,
        clipRoots: [this],
      }),
    );
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    const sectionId = `${this.section?.id ?? ""}`;
    return !this.hidden && sectionId
      ? mergeKeyboardNavigationContexts(
          this.taskCreate()?.keyboardNavigationContexts({
            scopeId: `section:${sectionId}`,
          }) ?? [],
          this.conversationShortcuts()?.keyboardNavigationContexts?.() ?? [],
        )
      : [];
  }

  sectionContextKey(section) {
    return JSON.stringify([
      `${section?.id ?? ""}`,
      cleanLogicalPath(section?.name),
    ]);
  }

  taskCreate() {
    return this.querySelector(":scope > caffold-task-create");
  }

  githubShortcuts() {
    return this.querySelector(":scope > caffold-section-github-shortcuts");
  }

  conversationShortcuts() {
    return this.querySelector(
      ":scope > caffold-section-conversation-shortcuts",
    );
  }

  syncTaskCreate() {
    const taskCreate = this.taskCreate();
    if (!taskCreate) {
      return;
    }
    taskCreate.setContext({
      cwd: this.selectedContextPath(),
      browseCwd: false,
      composerSettings: this.section?.composerSettings ?? null,
    });
    taskCreate.setServerPaths(this.server);
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  syncGitHubShortcuts() {
    this.githubShortcuts()?.setContext({
      key: this.sectionContextKey(this.section),
      path: this.selectedContextPath(),
      repository: Boolean(this.section?.repository),
    });
  }

  syncConversationShortcuts() {
    const shortcuts = this.conversationShortcuts();
    if (!shortcuts) {
      return;
    }
    shortcuts.setContext({
      key: this.sectionContextKey(this.section),
      sectionId: `${this.section?.id ?? ""}`,
      path: this.selectedContextPath(),
    });
    shortcuts.setTransportAvailable(this.transportAvailable);
    shortcuts.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }
}

if (!customElements.get("caffold-section-detail")) {
  customElements.define("caffold-section-detail", CaffoldSectionDetail);
}
