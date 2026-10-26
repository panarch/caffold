import { html, LitElement, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import type { ActiveTaskSection } from "#app/api.ts";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import type { TaskStoreStatusSnapshot } from "#app/pages/(task-workspace)/task-store-status.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import "../../components/task-create.ts";
import type { CaffoldTaskCreate } from "../../components/task-create.ts";
import { cleanLogicalPath } from "../../task-format.ts";
import "./components/conversation-shortcuts.ts";
import type { CaffoldSectionConversationShortcuts } from "./components/conversation-shortcuts.ts";
import "./components/github-shortcuts.ts";
import type { CaffoldSectionGithubShortcuts } from "./components/github-shortcuts.ts";

// The Section Detail opens: its identity, its directory as its name, whether
// that is a Git repository, and what a new Task there starts from.
export type DetailSection = Pick<
  ActiveTaskSection,
  "id" | "name" | "repository" | "composerSettings"
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
export class CaffoldSectionDetail extends LitElement {
  private section: DetailSection | null = null;
  private server: { root?: string; homePath?: string | null } = {};
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;
  private drawn = false;

  createRenderRoot() {
    return this;
  }

  setSection(section: DetailSection | null | undefined) {
    this.ensureDrawn();
    this.section = section ? { ...section } : null;
    this.draw();
    this.syncTaskCreate();
    this.syncConversationShortcuts();
    this.syncGitHubShortcuts();
  }

  activate() {
    this.ensureDrawn();
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
    this.drawn = false;
    this.section = null;
    this.draw();
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.server = { ...server };
    this.taskCreate()?.setServerPaths(this.server);
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
    this.taskCreate()?.setTransportAvailable(this.transportAvailable);
    this.conversationShortcuts()?.setTransportAvailable(
      this.transportAvailable,
    );
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
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
    );
  }

  scrollSurfaceScope() {
    this.ensureDrawn();
    const sectionId = `${this.section?.id ?? ""}`;
    if (this.hidden || !sectionId) {
      return emptyScrollSurfaceScope();
    }
    const section = {
      blocked: false,
      surfaces: [
        {
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
        },
      ],
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

  render() {
    if (!this.drawn) {
      return nothing;
    }
    return html`
      ${keyed(
        sectionContextKey(this.section),
        html`<caffold-task-create></caffold-task-create>`,
      )}
      <caffold-section-conversation-shortcuts hidden
      ></caffold-section-conversation-shortcuts>
      <caffold-section-github-shortcuts hidden
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
    return this.querySelector<CaffoldTaskCreate>(
      ":scope > caffold-task-create",
    );
  }

  private githubShortcuts() {
    return this.querySelector<CaffoldSectionGithubShortcuts>(
      ":scope > caffold-section-github-shortcuts",
    );
  }

  private conversationShortcuts() {
    return this.querySelector<CaffoldSectionConversationShortcuts>(
      ":scope > caffold-section-conversation-shortcuts",
    );
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

customElements.define("caffold-section-detail", CaffoldSectionDetail);

function sectionContextKey(section: DetailSection | null) {
  return JSON.stringify([
    `${section?.id ?? ""}`,
    cleanLogicalPath(section?.name),
  ]);
}
