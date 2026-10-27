import { html, LitElement, nothing } from "lit";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
} from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import {
  type TaskStoreStatusSnapshot,
  taskStoreBlocksTaskOperations,
} from "../../task-store-status.ts";
import { cleanLogicalPath } from "../task-format.ts";
import "./composer.ts";
import type {
  CaffoldTaskComposer,
  ComposerSubmission,
  ComposerSubmitDetail,
} from "./composer.ts";
import "./task-create/components/directory-field.ts";
import type {
  CaffoldTaskDirectoryField,
  DirectoryChosenDetail,
} from "./task-create/components/directory-field.ts";
import {
  directoryPathDisplay,
  type ServerPaths,
} from "./task-create/directory-path.ts";
import type { TurnSubmissionOptions } from "./task-turn-options.ts";

// What a New Task surface last ran under, which a new Task starts from.
export interface ComposerSettings {
  model: string;
  effort: string;
  fastMode: boolean;
  permissionMode: string;
}

// Settings as an owner hands them in, where a choice not made yet may be
// missing or null.
type ComposerSettingsInput = {
  [Key in keyof ComposerSettings]?: ComposerSettings[Key] | null;
};

// A request to start a Task, with as much of a submission as its asker has.
// The owner that takes it sets `accepted` and the `completion` that settles
// once the new Task holds the submission.
export interface TaskStartIntent {
  type: "start";
  request: {
    cwd?: string;
    titleSource: string;
  } & Partial<TurnSubmissionOptions>;
  submission: Partial<ComposerSubmission>;
  accepted: boolean;
  completion: Promise<unknown> | null;
}

export type TaskCreateIntentDetail =
  | { type: "choose-cwd"; path: string }
  | TaskStartIntent;

/**
 * Where a new Task works and what it is asked first: the directory above the
 * Composer, and the Composer that starts it.
 *
 * The surface that mounts it hands it the directory, the server's paths, and
 * whether Tasks can be made now, and starts the Task it asks for. It draws at
 * once wherever its state changes, since it hands its directory field and
 * Composer their context right after drawing them.
 */
export class CaffoldTaskCreate extends LitElement {
  private cwd = ".";
  private browseCwd = false;
  private server: ServerPaths = {};
  private composerSettings: ComposerSettings | null = null;
  private transportAvailable = true;
  private taskOperationsBlocked = false;
  private error: Error | null = null;
  private activeSubmissionId = "";
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly composerElement = new DrawnRef<CaffoldTaskComposer>(this);
  private readonly directoryElement = new DrawnRef<CaffoldTaskDirectoryField>(
    this,
  );

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.draw();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setContext({
    cwd = this.cwd,
    browseCwd = this.browseCwd,
    composerSettings = this.composerSettings,
  }: {
    cwd?: string;
    browseCwd?: boolean;
    composerSettings?: ComposerSettingsInput | null;
  } = {}) {
    const nextCwd = cleanLogicalPath(cwd || ".");
    const nextBrowseCwd = Boolean(browseCwd);
    const nextComposerSettings = normalizeComposerSettings(composerSettings);
    const changed =
      this.cwd !== nextCwd ||
      this.browseCwd !== nextBrowseCwd ||
      JSON.stringify(this.composerSettings) !==
        JSON.stringify(nextComposerSettings);
    this.cwd = nextCwd;
    this.browseCwd = nextBrowseCwd;
    this.composerSettings = nextComposerSettings;
    if (changed) {
      this.error = null;
    }
    this.draw();
    return changed;
  }

  // Where the server's root and home directory are, which decide how a
  // directory reads.
  setServerPaths({
    root = "",
    homePath = null,
  }: {
    root?: string;
    homePath?: string | null;
  } = {}) {
    this.server = { root, homePath };
    this.draw();
  }

  activate() {
    this.hidden = false;
    this.draw();
  }

  deactivate() {
    this.directoryField()?.deactivate();
    this.composer()?.endEditingLifetime();
  }

  setTransportAvailable(available: boolean) {
    if (this.transportAvailable === available) {
      return;
    }
    this.transportAvailable = available;
    this.draw();
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    // Only the store gates creating — it is shared by every agent. Codex
    // being unready costs the picker its Codex models and nothing more.
    const blocked = taskStoreBlocksTaskOperations(snapshot);
    if (this.taskOperationsBlocked === blocked) {
      return;
    }
    this.taskOperationsBlocked = blocked;
    this.draw();
  }

  selectedContextPath() {
    return cleanLogicalPath(this.cwd);
  }

  composer() {
    return this.composerElement.value ?? null;
  }

  directoryField() {
    return this.directoryElement.value ?? null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.directoryField()?.actionHintScope(pull),
      this.composer()?.actionHintScope(pull),
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return (
      this.directoryField()?.scrollSurfaceScope(pull) ??
      emptyScrollSurfaceScope()
    );
  }

  ownsEditingEscape(element: Element | null) {
    return Boolean(this.directoryField()?.ownsEditingEscape(element));
  }

  keyboardNavigationContexts(options: { scopeId?: string } = {}) {
    return this.composer()?.keyboardNavigationContexts(options) ?? [];
  }

  // The directory above the Composer: a field to choose it where the surface
  // lets you, and the fixed path where it does not.
  render() {
    const shown = directoryPathDisplay(this.selectedContextPath(), this.server);
    return html`
      <div class="task-create-directory">${
        this.browseCwd
          ? html`<caffold-task-directory-field
              ${drawn(this.directoryElement)}
              @caffold:task-directory-chosen=${this.directoryChosen}
            ></caffold-task-directory-field>`
          : html`<p class="task-create-fixed-directory">
              ${inlineIcon(
                "Folder",
                "Working directory",
                "task-create-fixed-directory-icon",
              )}
              <span class="task-create-fixed-directory-path" title=${shown}
                ><span dir="ltr">${shown}</span></span
              >
            </p>`
      }</div>
      <div class="task-create-status-region">${
        this.error
          ? html`<div class="task-create-status" role="alert">
              ${inlineIcon(
                "TriangleAlert",
                "Task creation failed",
                "task-create-status-icon",
              )}
              <span>${this.error.message}</span>
            </div>`
          : nothing
      }</div>
      <caffold-task-composer
        ${drawn(this.composerElement)}
        @caffold:task-composer-intent=${this.composerIntent}
        @caffold:task-composer-submit=${this.composerSubmit}
      ></caffold-task-composer>
    `;
  }

  // The field and the Composer are handed what they show once they are drawn.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    if (this.browseCwd) {
      this.directoryField()?.setContext({
        path: this.selectedContextPath(),
        server: this.server,
        locked: Boolean(this.activeSubmissionId),
      });
    }
    const settings = this.composerSettings;
    this.composer()?.setContext({
      mode: "create",
      className: "task-new-form",
      cwd: this.selectedContextPath(),
      placeholder: "Ask an agent to work from the current directory",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: false,
      model: settings?.model ?? "",
      effort: settings?.effort ?? "",
      fastMode: Boolean(settings?.fastMode),
      permissionMode: settings?.permissionMode ?? "",
      disabled: !this.transportAvailable || this.taskOperationsBlocked,
      requestError: this.error?.message ?? "",
    });
  }

  private composerIntent(event: Event) {
    if (event.target === this.composer()) {
      event.stopPropagation();
    }
  }

  private directoryChosen(event: CustomEvent<DirectoryChosenDetail>) {
    if (event.target !== this.directoryField()) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<TaskCreateIntentDetail>("caffold:task-create-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "choose-cwd", path: event.detail.path },
      }),
    );
    if (event.detail.returnFocus) {
      this.composer()?.focus();
    }
  }

  private async composerSubmit(event: CustomEvent<ComposerSubmitDetail>) {
    if (event.target !== this.composer()) {
      return;
    }
    event.stopPropagation();
    const { submissionId } = event.detail;
    if (!submissionId || this.activeSubmissionId) {
      return;
    }
    this.activeSubmissionId = submissionId;
    this.error = null;
    this.draw();
    try {
      const submission = this.composer()?.submissionSnapshot(submissionId);
      if (!submission) {
        throw new Error("The Task prompt could not be prepared for creation.");
      }
      const cwd = this.selectedContextPath();
      const intent: TaskStartIntent = {
        type: "start",
        request: {
          ...(cwd ? { cwd } : {}),
          titleSource: submission.prompt,
          ...submission.options,
        },
        submission,
        accepted: false,
        completion: null,
      };
      this.dispatchEvent(
        new CustomEvent<TaskCreateIntentDetail>("caffold:task-create-intent", {
          bubbles: true,
          composed: true,
          detail: intent,
        }),
      );
      if (!intent.accepted || !intent.completion) {
        throw new Error("Another Task is already starting.");
      }
      await intent.completion;
      this.composer()?.takeSubmission(submissionId);
      // The Tasks page handed the request and its exact options to the new
      // Task composer. End this New Task editing lifetime so a later New
      // surface starts from canonical defaults instead of inheriting it.
      this.composer()?.endEditingLifetime();
      this.activeSubmissionId = "";
      this.draw();
    } catch (error) {
      this.activeSubmissionId = "";
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.draw();
      this.composer()?.resolveSubmission(submissionId, {
        status: "rejected",
        error: this.error,
      });
    }
  }
}

function normalizeComposerSettings(
  settings: ComposerSettingsInput | null,
): ComposerSettings | null {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return {
    model: settings.model ?? "",
    effort: settings.effort ?? "",
    fastMode: Boolean(settings.fastMode),
    permissionMode: settings.permissionMode ?? "",
  };
}

customElements.define("caffold-task-create", CaffoldTaskCreate);
