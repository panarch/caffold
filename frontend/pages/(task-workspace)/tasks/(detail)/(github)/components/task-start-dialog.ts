import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import {
  createTask,
  type GitHubIssue,
  type GitHubPull,
  type GitRepository,
} from "#app/api.ts";
import {
  KeyboardContexts,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "#tasks/components/task-turn-options.ts";
import type {
  CaffoldTaskTurnOptions,
  TurnOptionsSelection,
} from "#tasks/components/task-turn-options.ts";
import "./task-start-dialog/components/github-issue.ts";
import type { CaffoldGithubIssueTaskSource } from "./task-start-dialog/components/github-issue.ts";
import "./task-start-dialog/components/github-pull.ts";
import type { CaffoldGithubPullTaskSource } from "./task-start-dialog/components/github-pull.ts";

// The issue or pull request a Task is started for.
export type TaskStartSource =
  | { kind: "issue"; payload: GitHubIssue }
  | { kind: "pull"; payload: GitHubPull };

// What the dialog shows for its source, as the source and Turn Options say.
interface Setup {
  title: string;
  sourceTitle: string;
  // The issue or pull request's number, which names its keyboard context.
  number: string;
  ready: boolean;
}

export class CaffoldGithubTaskStartDialog extends LitElement {
  static properties = {
    sourceKind: { state: true },
    pending: { state: true },
    error: { state: true },
    setup: { state: true },
  };

  declare private sourceKind: TaskStartSource["kind"] | null;
  declare private pending: boolean;
  declare private error: Error | null;
  declare private setup: Setup;
  private repository: GitRepository | null = null;
  private opener: HTMLElement | null = null;
  private createRequestId = 0;
  private restoreFocus = true;
  private composerSettings: TurnOptionsSelection | null = null;
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly modal = new DrawnRef<HTMLDialogElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly issue = new DrawnRef<CaffoldGithubIssueTaskSource>(this);
  private readonly pull = new DrawnRef<CaffoldGithubPullTaskSource>(this);
  private readonly options = new DrawnRef<CaffoldTaskTurnOptions>(this);
  private readonly cancelButton = new DrawnRef<HTMLButtonElement>(this);

  constructor() {
    super();
    this.sourceKind = null;
    this.pending = false;
    this.error = null;
    this.setup = { title: "", sourceTitle: "", number: "", ready: false };
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const setup = this.setup;
    return html`
      <dialog
        ${drawn(this.modal)}
        ${this.keyboard.modal({
          id: `github-task-start:${this.sourceKind}:${encodeURIComponent(
            setup.number,
          )}`,
          when: Boolean(this.sourceKind && setup.number),
        })}
        closedby="any"
        aria-labelledby="github-task-start-title"
        aria-describedby="github-task-start-description"
        aria-busy=${this.pending ? "true" : "false"}
        @close=${this.handleClose}
        @cancel=${this.holdWhilePending}
      >
        <form class="github-task-start-card" @submit=${this.submit}>
          <header>
            <h2 id="github-task-start-title">${setup.title}</h2>
            <p class="github-task-start-source-title">${setup.sourceTitle}</p>
            <p id="github-task-start-description">
              Creates a Task and prepares a clean worktree. Work stops when
              ready.
            </p>
          </header>
          <div
            ${drawn(this.body)}
            ${this.surfaces.surface({
              id: "setup",
              label: () => "GitHub Task setup",
              clipRoots: () => [this.body.value],
            })}
            class="github-task-start-body"
          >
            <caffold-github-issue-task-source
              ${drawn(this.issue)}
              ?hidden=${this.sourceKind !== "issue"}
              @caffold:github-task-source-change=${this.followSource}
            ></caffold-github-issue-task-source>
            <caffold-github-pull-task-source
              ${drawn(this.pull)}
              ?hidden=${this.sourceKind !== "pull"}
              @caffold:github-task-source-change=${this.followSource}
            ></caffold-github-pull-task-source>
            <caffold-task-turn-options
              ${drawn(this.options)}
              @caffold:task-turn-options-change=${this.updateSetup}
            ></caffold-task-turn-options>
            <div class="github-task-start-error" aria-live="assertive">${
              this.error
                ? html`<p role="alert">${this.error.message}</p>`
                : nothing
            }</div>
          </div>
          <footer>
            <button
              ${drawn(this.cancelButton)}
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="button"
              class="github-task-start-button"
              data-task-start-dialog-action="cancel"
              ?disabled=${this.pending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "start",
                label: this.pending ? "Starting..." : "Start Task",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="github-task-start-button is-primary"
              ?disabled=${this.pending || !setup.ready}
            >${this.pending ? "Starting..." : "Start Task"}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  open(
    request: TaskStartSource & {
      repository: GitRepository | null;
      composerSettings: unknown;
      opener: unknown;
    },
  ) {
    const source =
      request.kind === "pull" ? request.payload?.pull : request.payload?.issue;
    const rootPath =
      `${request.repository?.rootPath ?? request.payload?.repository?.rootPath ?? ""}`.trim();
    if (!source || !rootPath) {
      return false;
    }
    this.issueSource.deactivate();
    this.pullSource.deactivate();
    this.sourceKind = request.kind;
    this.repository = {
      ...(request.repository ?? request.payload.repository),
      rootPath,
    };
    this.composerSettings = normalizeComposerSettings(request.composerSettings);
    this.opener = request.opener instanceof HTMLElement ? request.opener : null;
    this.restoreFocus = true;
    this.createRequestId += 1;
    this.pending = false;
    this.error = null;
    if (request.kind === "pull") {
      this.pullSource.setContext({
        payload: request.payload,
        repository: this.repository,
      });
    } else {
      this.issueSource.setContext({
        payload: request.payload,
        repository: this.repository,
      });
    }
    this.turnOptions.reset({
      cwd: rootPath,
      initialSelection: this.composerSettings ?? {},
      placement: "below",
    });
    this.updateSetup();
    const dialog = this.dialog;
    dialog.returnValue = "";
    if (!dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  deactivate() {
    this.createRequestId += 1;
    this.pending = false;
    this.error = null;
    this.restoreFocus = false;
    this.issueSource.deactivate();
    this.pullSource.deactivate();
    this.turnOptions.hidePopovers();
    if (this.dialog.open) {
      this.dialog.close("cancel");
    }
  }

  setComposerSettings(settings: unknown) {
    this.composerSettings = normalizeComposerSettings(settings);
    if (!this.dialog.open) {
      return;
    }
    this.turnOptions.setContext({
      initialSelection: this.composerSettings ?? {},
    });
  }

  actionHintScope(pull: ActionHintPull = {}) {
    const body = this.body.value;
    const clipRoots = [...(pull.clipRoots ?? []), ...(body ? [body] : [])];
    const own = this.hints.scope(pull);
    return mergeActionHintScopes(
      own,
      {
        ...this.turnOptions.actionHintScope({
          scopeId: pull.scopeId,
          clipRoots,
        }),
        blocked: this.pending,
      },
      this.sourceComponent?.actionHintScope({ ...pull, clipRoots }),
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    const body = this.body.value;
    const own = this.surfaces.scope(pull);
    return mergeScrollSurfaceScopes(
      own,
      this.sourceKind === "pull"
        ? this.pullSource.scrollSurfaceScope({
            scopeId: `${pull.scopeId}:source`,
            clipRoots: [...(pull.clipRoots ?? []), ...(body ? [body] : [])],
          })
        : null,
    );
  }

  keyboardNavigationContexts() {
    const contexts = this.keyboard.contexts({
      actionHints: (pull) => this.actionHintScope(pull),
      scroll: (pull) => this.scrollSurfaceScope(pull),
      editing: {
        // Escape in the branch list cancels rather than closing the list.
        escapeTarget: (editable) =>
          this.issueSource.isBaseRefSelect(editable)
            ? (this.cancelButton.value ?? null)
            : null,
      },
    });
    return mergeKeyboardNavigationContexts(
      contexts,
      ...contexts.map(({ id }) =>
        this.turnOptions.keyboardNavigationContexts({ scopeId: id }),
      ),
    );
  }

  private async startTask() {
    const sourceComponent = this.sourceComponent;
    if (
      this.pending ||
      !sourceComponent?.readyForSubmission() ||
      !this.repository?.rootPath ||
      !this.turnOptions.readyForSubmission()
    ) {
      return;
    }
    const requestId = ++this.createRequestId;
    this.pending = true;
    this.error = null;
    this.updateSetup();
    try {
      const options = this.turnOptions.submissionOptions();
      const prompt = await sourceComponent.prepareSetup(
        options.provider ?? "codex",
      );
      if (requestId !== this.createRequestId) {
        return;
      }
      if (!prompt) {
        this.pending = false;
        this.updateSetup();
        return;
      }
      const created = await createTask({
        cwd: this.repository.rootPath,
        titleSource: prompt,
        ...options,
      });
      if (requestId !== this.createRequestId) {
        return;
      }
      const handoff = {
        created,
        submission: {
          submissionId: `github:${Date.now()}:${requestId}`,
          prompt,
          attachments: [],
          options,
        },
        adopted: false,
      };
      this.dispatchEvent(
        new CustomEvent("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error(
          "The created Task could not take ownership of its prompt.",
        );
      }
      this.pending = false;
      this.turnOptions.resetFastMode();
      this.dialog.close("started");
    } catch (error) {
      if (requestId !== this.createRequestId) {
        return;
      }
      this.pending = false;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.updateSetup();
    }
  }

  // The title and whether a Task can start follow the source and Turn
  // Options, which lock while a start is under way.
  private updateSetup() {
    const sourceComponent = this.sourceComponent;
    const source = sourceComponent?.source();
    if (!sourceComponent || !source || !this.repository?.rootPath) {
      return;
    }
    this.setup = {
      title:
        this.sourceKind === "pull"
          ? `Start Task for PR #${source.number}`
          : `Start Task for #${source.number}`,
      sourceTitle: `${source.title ?? ""}`,
      number: `${source.number ?? ""}`,
      ready:
        sourceComponent.readyForSubmission() &&
        this.turnOptions.readyForSubmission(),
    };
    sourceComponent.setLocked(this.pending);
    this.turnOptions.setContext({
      cwd: this.repository.rootPath,
      locked: this.pending,
      placement: "below",
    });
  }

  private followSource(event: Event) {
    if (event.currentTarget !== this.sourceComponent) {
      return;
    }
    event.stopPropagation();
    this.updateSetup();
  }

  private submit(event: Event) {
    event.preventDefault();
    void this.startTask();
  }

  private cancel() {
    if (!this.pending) {
      this.dialog.close("cancel");
    }
  }

  private holdWhilePending(event: Event) {
    if (this.pending) {
      event.preventDefault();
    }
  }

  private handleClose() {
    if (this.pending) {
      return;
    }
    this.turnOptions.hidePopovers();
    const opener = this.opener;
    const restoreFocus = this.restoreFocus;
    this.opener = null;
    this.restoreFocus = true;
    if (restoreFocus && opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  private get sourceComponent() {
    if (this.sourceKind === "issue") {
      return this.issueSource;
    }
    return this.sourceKind === "pull" ? this.pullSource : null;
  }

  // The children are drawn the first time one is needed, which can be before
  // the dialog is in the document.
  private get dialog() {
    this.performUpdate();
    return this.modal.value as HTMLDialogElement;
  }

  private get issueSource() {
    this.performUpdate();
    return this.issue.value as CaffoldGithubIssueTaskSource;
  }

  private get pullSource() {
    this.performUpdate();
    return this.pull.value as CaffoldGithubPullTaskSource;
  }

  private get turnOptions() {
    this.performUpdate();
    return this.options.value as CaffoldTaskTurnOptions;
  }
}

customElements.define(
  "caffold-github-task-start-dialog",
  CaffoldGithubTaskStartDialog,
);

function normalizeComposerSettings(
  settings: unknown,
): TurnOptionsSelection | null {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  const { model, effort, fastMode, permissionMode } = settings as Record<
    string,
    unknown
  >;
  return {
    model: `${model ?? ""}`,
    effort: `${effort ?? ""}`,
    fastMode: Boolean(fastMode),
    permissionMode: `${permissionMode ?? ""}`,
  };
}
