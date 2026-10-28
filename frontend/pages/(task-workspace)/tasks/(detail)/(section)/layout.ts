import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { mergeActionHintScopes } from "#app/action-hints.js";
import type { ActiveTaskSection } from "#app/api.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import type { TaskStoreStatusSnapshot } from "#app/pages/(task-workspace)/task-store-status.js";
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
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldSectionGithubShortcuts } from "./components/github-shortcuts.js";

import styles from "./layout.css.js";

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
@customElement("caffold-section-detail")
export class CaffoldSectionDetail extends CaffoldElement {
  static override styles = styles;

  private section: DetailSection | null = null;
  private server: { root?: string; homePath?: string | null } = {};
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;
  private drawn = false;
  private readonly create = new DrawnRef<CaffoldTaskCreate>(this);
  private readonly conversations =
    new DrawnRef<CaffoldSectionConversationShortcuts>(this);
  private readonly github = new DrawnRef<CaffoldSectionGithubShortcuts>(this);

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
      ${keyed(
        sectionContextKey(this.section),
        html`<caffold-task-create ${drawn(this.create)}></caffold-task-create>`,
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
