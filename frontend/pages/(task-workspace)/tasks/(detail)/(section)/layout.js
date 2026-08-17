import "../../components/task-create.js";
import "./components/github-shortcuts.js";
import { cleanLogicalPath } from "../../task-format.js";

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
      <caffold-section-github-shortcuts hidden></caffold-section-github-shortcuts>
    `;
    this.syncTaskCreate();
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
    this.syncGitHubShortcuts();
  }

  activate() {
    this.ensureRendered();
    this.hidden = false;
    this.githubShortcuts()?.activate();
    this.taskCreate()?.activate();
  }

  deactivate() {
    this.githubShortcuts()?.deactivate();
    this.taskCreate()?.deactivate();
  }

  clear() {
    this.taskCreate()?.deactivate();
    this.replaceChildren();
    this.section = null;
  }

  setTransportAvailable(available) {
    this.ensureState();
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureState();
    this.codexStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setCodexStatusSnapshot(this.codexStatusSnapshot);
  }

  selectedContextPath() {
    return `${this.section?.name ?? ""}`;
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
}

if (!customElements.get("caffold-section-detail")) {
  customElements.define("caffold-section-detail", CaffoldSectionDetail);
}
