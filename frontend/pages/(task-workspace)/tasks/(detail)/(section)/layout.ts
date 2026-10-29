import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import {
  type ActiveTaskSection,
  getSectionDirectory,
  type SectionDirectory,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import {
  type TaskStoreStatusSnapshot,
  taskStoreBlocksTaskOperations,
} from "#app/pages/(task-workspace)/task-store-status.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "../../components/task-create.js";
import type { CaffoldTaskCreate } from "../../components/task-create.js";
import { cleanLogicalPath } from "../../task-format.js";
import "./components/conversation-shortcuts.js";
import type { CaffoldSectionConversationShortcuts } from "./components/conversation-shortcuts.js";
import "./components/github-shortcuts.js";
import type { CaffoldSectionGithubShortcuts } from "./components/github-shortcuts.js";
import "./components/folder-recovery.js";
import type { CaffoldSectionFolderRecovery } from "./components/folder-recovery.js";

import styles from "./layout.css.js";

// The Section Detail opens: its identity, its directory as its name, whether
// that is a Git repository, and what a new Task there starts from.
export type DetailSection = Pick<
  ActiveTaskSection,
  "id" | "name" | "repository" | "composerSettings" | "directory"
>;

/**
 * A Section's own screen: New Task fixed to the Section's directory, and the
 * shortcuts beside it that start a Task from an existing conversation or open
 * the repository's GitHub work.
 *
 * Nothing is drawn until the Tasks Detail layout first needs it, and clear()
 * puts it back that way. A Section with another directory gets a New Task
 * surface of its own, so no draft follows it from the last one. The layout
 * reads it right after each change, so it draws at once.
 */
@customElement("caffold-section-detail")
export class CaffoldSectionDetail extends CaffoldElement {
  static override styles = styles;

  private section: DetailSection | null = null;
  private server: { root?: string; homePath?: string | null } = {};
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;
  private drawn = false;
  private active = false;
  private directoryCheckGeneration = 0;
  private readonly recovery = new DrawnRef<CaffoldSectionFolderRecovery>(this);
  private readonly create = new DrawnRef<CaffoldTaskCreate>(this);
  private readonly conversations =
    new DrawnRef<CaffoldSectionConversationShortcuts>(this);
  private readonly github = new DrawnRef<CaffoldSectionGithubShortcuts>(this);

  setSection(section: DetailSection | null | undefined) {
    this.ensureDrawn();
    const changed =
      sectionContextKey(this.section) !== sectionContextKey(section ?? null) ||
      this.section?.directory?.status !== section?.directory?.status ||
      this.section?.directory?.message !== section?.directory?.message;
    if (changed) {
      this.directoryCheckGeneration += 1;
    }
    this.section = section ? { ...section } : null;
    this.draw();
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
    this.syncRecovery();
    if (changed) {
      this.checkAvailableDirectory();
    }
  }

  activate() {
    this.ensureDrawn();
    this.hidden = false;
    const activated = this.setActive(true);
    if (!this.unavailable()) {
      this.conversationShortcuts()?.activate();
      this.githubShortcuts()?.activate();
      this.taskCreate()?.activate();
    }
    this.syncRecovery();
    if (activated) {
      this.checkAvailableDirectory();
    }
  }

  deactivate() {
    this.setActive(false);
    this.recovery.value?.deactivate();
    this.conversationShortcuts()?.deactivate();
    this.githubShortcuts()?.deactivate();
    this.taskCreate()?.deactivate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  clear() {
    this.deactivate();
    this.drawn = false;
    this.section = null;
    this.draw();
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.server = { ...server };
    this.taskCreate()?.setServerPaths(this.server);
    this.syncRecovery();
  }

  setTransportAvailable(available: boolean) {
    const regained = available && !this.transportAvailable;
    if (!available) {
      this.directoryCheckGeneration += 1;
    }
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
    this.conversationShortcuts()?.setTransportAvailable(
      this.transportAvailable,
    );
    this.syncRecovery();
    if (regained) {
      this.checkAvailableDirectory();
    }
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.taskCreate()?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
    this.conversationShortcuts()?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
    this.syncRecovery();
  }

  selectedContextPath() {
    return `${this.section?.name ?? ""}`;
  }

  ownsEditingEscape(element: Element | null) {
    return Boolean(this.recovery.value?.ownsEditingEscape(element));
  }

  actionHintScope() {
    this.ensureDrawn();
    const taskCreate = this.taskCreate();
    const sectionId = `${this.section?.id ?? ""}`;
    const scopeId = `section:${sectionId}`;
    return mergeActionHintScopes(
      sectionId
        ? taskCreate?.actionHintScope({ scopeId, clipRoots: [this] })
        : null,
      { blocked: false, targets: [], mutationRoots: [], scrollRoots: [this] },
      this.conversationShortcuts()?.actionHintScope({
        scopeId,
        clipRoots: [this],
      }),
      this.githubShortcuts()?.actionHintScope({
        scopeId,
        clipRoots: [this],
      }),
      this.recovery.value?.actionHintScope({ scopeId, clipRoots: [this] }),
    );
  }

  scrollSurfaceScope() {
    this.ensureDrawn();
    const sectionId = `${this.section?.id ?? ""}`;
    if (this.hidden || !sectionId) {
      return emptyScrollSurfaceScope();
    }
    // The Section scrolls as a whole, and the host is no template's to draw.
    const section = {
      blocked: false,
      surfaces: hasScrollLayoutBox(this)
        ? [
            {
              id: `section:${sectionId}:scroll`,
              label: this.section?.name
                ? `Section ${this.section.name}`
                : "Section",
              scrollport: this,
              clipRoots: [this],
            },
          ]
        : [],
      mutationRoots: [this, this.renderRoot],
      resizeElements: [this],
      scrollRoots: [this],
    };
    return mergeScrollSurfaceScopes(
      section,
      this.taskCreate()?.scrollSurfaceScope({
        scopeId: `section:${sectionId}`,
        clipRoots: [this],
      }),
      this.recovery.value?.scrollSurfaceScope({
        scopeId: `section:${sectionId}`,
      }),
    );
  }

  keyboardNavigationContexts() {
    this.ensureDrawn();
    const sectionId = `${this.section?.id ?? ""}`;
    return !this.hidden && sectionId
      ? mergeKeyboardNavigationContexts(
          this.taskCreate()?.keyboardNavigationContexts({
            scopeId: `section:${sectionId}`,
          }) ?? [],
          this.conversationShortcuts()?.keyboardNavigationContexts() ?? [],
        )
      : [];
  }

  override render() {
    if (!this.drawn) {
      return nothing;
    }
    return html`
      <caffold-section-folder-recovery
        ${drawn(this.recovery)}
        ?hidden=${!this.unavailable()}
        @caffold:section-directory-observed=${this.directoryObserved}
      ></caffold-section-folder-recovery>
      ${keyed(
        sectionContextKey(this.section),
        html`
          <caffold-task-create
            ${drawn(this.create)}
            ?hidden=${this.unavailable()}
          ></caffold-task-create>
        `,
      )}
      <caffold-section-conversation-shortcuts
        ${drawn(this.conversations)}
        hidden
      ></caffold-section-conversation-shortcuts>
      <caffold-section-github-shortcuts
        ${drawn(this.github)}
        hidden
      ></caffold-section-github-shortcuts>
    `;
  }

  // The children are drawn the first time anything needs them, and handed
  // what they show then.
  private ensureDrawn() {
    if (this.drawn) {
      return;
    }
    this.drawn = true;
    this.draw();
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
  }

  private taskCreate() {
    return this.create.value;
  }

  private githubShortcuts() {
    return this.github.value;
  }

  private conversationShortcuts() {
    return this.conversations.value;
  }

  private syncTaskCreate() {
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

  private unavailable() {
    return Boolean(
      this.section?.directory && this.section.directory.status !== "available",
    );
  }

  private syncRecovery() {
    const recovery = this.recovery.value;
    if (!recovery) {
      return;
    }
    const recovering = this.active && this.unavailable();
    if (!recovering) {
      recovery.deactivate();
    }
    const create = this.taskCreate();
    if (create) {
      create.hidden = this.unavailable();
    }
    recovery.setContext(
      this.section?.directory
        ? { id: this.section.id, path: this.section.name }
        : null,
      this.server,
    );
    recovery.setAvailable(
      this.transportAvailable,
      taskStoreBlocksTaskOperations(this.taskStoreStatusSnapshot),
    );
    if (recovering) {
      recovery.activate();
    }
    if (this.unavailable()) {
      this.taskCreate()?.deactivate();
      this.conversationShortcuts()?.deactivate();
      this.githubShortcuts()?.deactivate();
      if (this.conversations.value) {
        this.conversations.value.hidden = true;
      }
      if (this.github.value) {
        this.github.value.hidden = true;
      }
    }
  }

  private directoryObserved(event: CustomEvent<SectionDirectory>) {
    event.stopPropagation();
    this.observeDirectory(event.detail);
  }

  private observeDirectory(directory: SectionDirectory) {
    if (!this.section || directory.sectionId !== this.section.id) {
      return;
    }
    const changed =
      directory.path !== this.section.name ||
      directory.directory.status !== this.section.directory?.status ||
      directory.directory.message !== this.section.directory?.message;
    if (!changed) {
      return;
    }
    // The Tasks list remains the owner of Section metadata. A refreshed list
    // supplies the new path; the local observation only gates this surface.
    if (directory.path === this.section.name) {
      this.section = { ...this.section, directory: directory.directory };
    }
    this.draw();
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
    if (this.active && !this.unavailable()) {
      this.taskCreate()?.activate();
      this.conversationShortcuts()?.activate();
      this.githubShortcuts()?.activate();
    }
    this.syncRecovery();
    this.refreshSectionList();
  }

  // The Section has two lifetime nodes, written only here. Activation starts
  // its current child or one directory check; deactivation invalidates both.
  // Context and transport changes rebind effects without adding control nodes.
  private setActive(active: boolean) {
    if (this.active === active) {
      return false;
    }
    this.active = active;
    this.directoryCheckGeneration += 1;
    return true;
  }

  private checkAvailableDirectory() {
    const section = this.section;
    if (
      !this.active ||
      !this.transportAvailable ||
      section?.directory?.status !== "available"
    ) {
      return;
    }
    const generation = ++this.directoryCheckGeneration;
    const current = () =>
      this.active &&
      generation === this.directoryCheckGeneration &&
      section.id === this.section?.id &&
      section.name === this.section?.name;

    void getSectionDirectory(section.id).then(
      (directory) => {
        if (current()) {
          this.observeDirectory(directory);
        }
      },
      () => {
        // A failed read cannot become a guessed directory state. Let the
        // canonical list reconcile Section removal or an unavailable store.
        if (current()) {
          this.refreshSectionList();
        }
      },
    );
  }

  private refreshSectionList() {
    this.dispatchEvent(
      new CustomEvent("caffold:section-directory-changed", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private syncGitHubShortcuts() {
    this.githubShortcuts()?.setContext({
      key: sectionContextKey(this.section),
      path: this.selectedContextPath(),
      repository: Boolean(this.section?.repository),
    });
  }

  private syncConversationShortcuts() {
    const shortcuts = this.conversationShortcuts();
    if (!shortcuts) {
      return;
    }
    shortcuts.setContext({
      key: sectionContextKey(this.section),
      sectionId: `${this.section?.id ?? ""}`,
      path: this.selectedContextPath(),
    });
    shortcuts.setTransportAvailable(this.transportAvailable);
    shortcuts.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

function sectionContextKey(section: DetailSection | null) {
  return JSON.stringify([
    `${section?.id ?? ""}`,
    cleanLogicalPath(section?.name),
  ]);
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-section-detail": CaffoldSectionDetail;
  }
}
