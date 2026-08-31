import "../../components/task-create.js";
import "./components/conversation-shortcuts.js";
import "./components/github-shortcuts.js";
import { cleanLogicalPath } from "../../task-format.js";
import { mergeActionHintScopes } from "../../../action-hints.js";

class CaffoldSectionDetail extends HTMLElement {
  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.section = null;
    this.transportAvailable = true;
    this.codexStatusSnapshot = null;
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

  setTransportAvailable(available) {
    this.ensureState();
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
    this.conversationShortcuts()?.setTransportAvailable(this.transportAvailable);
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureState();
    this.codexStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
    this.conversationShortcuts()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
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
      {
        targets: sectionId
          ? taskCreate?.actionHintTargets({
              scopeId,
              clipRoots: [this],
            }) ?? []
          : [],
        mutationRoots: [taskCreate].filter(Boolean),
        scrollRoots: [this],
      },
      this.githubShortcuts()?.actionHintScope({
        scopeId,
        clipRoots: [this],
      }),
    );
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
    taskCreate.setTransportAvailable(this.transportAvailable);
    taskCreate.setCodexStatusSnapshot(this.codexStatusSnapshot);
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
    shortcuts.setCodexStatusSnapshot(this.codexStatusSnapshot);
  }
}

if (!customElements.get("caffold-section-detail")) {
  customElements.define("caffold-section-detail", CaffoldSectionDetail);
}
