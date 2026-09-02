import { createTask } from "../../../../../../api.js";
import { escapeHtml } from "../../../../../../components/dom.js";
import "../../../components/task-turn-options.js";
import "./task-start-dialog/components/github-issue.js";
import "./task-start-dialog/components/github-pull.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../action-hints.js";
import {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "../../../../../../keyboard-navigation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../../../../../scroll-scope.js";
import "../../../../../../keyboard-navigation/components/presentation.js";

class CaffoldGithubTaskStartDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.sourceKind = null;
    this.repository = null;
    this.opener = null;
    this.pending = false;
    this.error = null;
    this.createRequestId = 0;
    this.restoreFocus = true;
    this.composerSettings = null;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
    this.dialog().addEventListener("cancel", (event) => {
      if (this.pending) {
        event.preventDefault();
      }
    });
    this.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-task-start-dialog-action]");
      if (action?.dataset.taskStartDialogAction === "cancel" && !this.pending) {
        this.dialog().close("cancel");
      }
    });
    this.addEventListener("caffold:github-task-source-change", (event) => {
      if (event.target !== this.sourceComponent()) {
        return;
      }
      event.stopPropagation();
      this.patch();
    });
    this.addEventListener("caffold:task-turn-options-change", (event) => {
      if (event.target === this.turnOptions()) {
        this.patch();
      }
    });
    this.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.startTask();
    });
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  issueSource() {
    return this.querySelector(":scope caffold-github-issue-task-source");
  }

  pullSource() {
    return this.querySelector(":scope caffold-github-pull-task-source");
  }

  sourceComponent() {
    if (this.sourceKind === "issue") {
      return this.issueSource();
    }
    return this.sourceKind === "pull" ? this.pullSource() : null;
  }

  turnOptions() {
    return this.querySelector(":scope caffold-task-turn-options");
  }

  actionHintScope() {
    const dialog = this.dialog();
    const body = dialog?.querySelector(".github-task-start-body");
    const source = this.sourceComponent();
    const sourceNumber = `${source?.source?.()?.number ?? ""}`;
    const sourceKind = `${this.sourceKind ?? ""}`;
    if (!dialog || !body || !sourceKind || !sourceNumber) {
      return emptyActionHintScope();
    }
    const scopeId = `github-task-start:${sourceKind}:${encodeURIComponent(
      sourceNumber,
    )}`;
    const ownScope = {
      blocked: false,
      targets: [
        ["cancel", '[data-task-start-dialog-action="cancel"]'],
        ["start", 'button[type="submit"]'],
      ].flatMap(([identity, selector]) => {
        const control = dialog.querySelector(selector);
        if (!control) {
          return [];
        }
        return [buttonActionHintTarget({
          id: `${scopeId}:${identity}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || identity,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog() === dialog &&
            dialog.open &&
            this.sourceKind === sourceKind &&
            `${this.sourceComponent()?.source?.()?.number ?? ""}` ===
              sourceNumber &&
            dialog.querySelector(selector) === control &&
            !control.disabled,
        })];
      }),
      mutationRoots: [this],
      scrollRoots: [],
    };
    const turnOptions = this.turnOptions();
    const turnScope = {
      blocked: this.pending,
      targets: [
        turnOptions?.actionHintModelTarget({
          scopeId,
          clipRoots: [dialog, body],
        }),
        turnOptions?.actionHintPermissionTarget({
          scopeId,
          clipRoots: [dialog, body],
        }),
      ].filter(Boolean),
      mutationRoots: [turnOptions].filter(Boolean),
      scrollRoots: [],
    };
    return mergeActionHintScopes(
      ownScope,
      turnScope,
      source.actionHintScope?.({
        scopeId,
        clipRoots: [dialog, body],
      }),
    );
  }

  scrollSurfaceScope() {
    const dialog = this.dialog();
    const scrollport = dialog?.querySelector(".github-task-start-body");
    const sourceKind = `${this.sourceKind ?? ""}`;
    const sourceNumber = `${this.sourceComponent()?.source?.()?.number ?? ""}`;
    if (!dialog || !scrollport || !sourceKind || !sourceNumber) {
      return emptyScrollSurfaceScope();
    }
    const scopeId = `github-task-start:${sourceKind}:${encodeURIComponent(
      sourceNumber,
    )}`;
    const ownScope = {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:setup`,
        label: "GitHub Task setup",
        scrollport,
        clipRoots: [dialog, scrollport],
        isEligible: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          this.sourceKind === sourceKind &&
          `${this.sourceComponent()?.source?.()?.number ?? ""}` ===
            sourceNumber &&
          dialog.querySelector(".github-task-start-body") === scrollport &&
          hasScrollLayoutBox(dialog) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
    return mergeScrollSurfaceScopes(
      ownScope,
      this.sourceComponent()?.scrollSurfaceScope?.({
        scopeId: `${scopeId}:source`,
        clipRoots: [dialog, scrollport],
      }),
    );
  }

  open({ kind, payload, repository, composerSettings, opener } = {}) {
    const sourceKind = kind === "pull" ? "pull" : kind === "issue" ? "issue" : null;
    const source = sourceKind ? payload?.[sourceKind] : null;
    const rootPath = `${repository?.rootPath ?? payload?.repository?.rootPath ?? ""}`.trim();
    if (!sourceKind || !source || !rootPath) {
      return false;
    }

    this.issueSource().deactivate();
    this.pullSource().deactivate();
    this.sourceKind = sourceKind;
    this.repository = { ...(repository ?? payload?.repository), rootPath };
    this.composerSettings = normalizeComposerSettings(composerSettings);
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.restoreFocus = true;
    this.createRequestId += 1;
    this.pending = false;
    this.error = null;
    this.issueSource().hidden = sourceKind !== "issue";
    this.pullSource().hidden = sourceKind !== "pull";
    this.sourceComponent().setContext({ payload, repository: this.repository });
    this.turnOptions().reset({
      cwd: rootPath,
      initialSelection: this.composerSettings ?? {},
      placement: "below",
    });
    this.patch();

    const dialog = this.dialog();
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
    this.issueSource().deactivate();
    this.pullSource().deactivate();
    this.turnOptions()?.hidePopovers();
    if (this.dialog().open) {
      this.dialog().close("cancel");
    }
  }

  setComposerSettings(settings) {
    this.composerSettings = normalizeComposerSettings(settings);
    if (!this.dialog()?.open) {
      return;
    }
    this.turnOptions().setContext({
      initialSelection: this.composerSettings ?? {},
    });
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    const source = this.sourceComponent();
    const sourceNumber = `${source?.source?.()?.number ?? ""}`;
    const sourceKind = `${this.sourceKind ?? ""}`;
    if (
      !dialog?.open ||
      !hintDialog ||
      !hud ||
      !selector ||
      !sourceKind ||
      !sourceNumber
    ) {
      return [];
    }
    const scopeId = `github-task-start:${sourceKind}:${encodeURIComponent(
      sourceNumber,
    )}`;
    const modalContext = keyboardNavigationContext({
      id: scopeId,
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
      scroll: {
        hud,
        selector,
        scope: this.scrollSurfaceScope(),
      },
      editing: {
        escapeTarget: (editable) => {
          const select = this.issueSource()?.querySelector(
            "select[name='baseRef']",
          );
          return editable === select
            ? dialog.querySelector(
                '[data-task-start-dialog-action="cancel"]',
              )
            : null;
        },
      },
    });
    return mergeKeyboardNavigationContexts(
      [modalContext],
      this.turnOptions()?.keyboardNavigationContexts({ scopeId }) ?? [],
    );
  }

  async startTask() {
    const sourceComponent = this.sourceComponent();
    if (
      this.pending ||
      !sourceComponent?.readyForSubmission() ||
      !this.repository?.rootPath ||
      !this.turnOptions().readyForSubmission()
    ) {
      return;
    }

    const requestId = ++this.createRequestId;
    this.pending = true;
    this.error = null;
    this.patch();
    try {
      const options = this.turnOptions().submissionOptions();
      const prompt = await sourceComponent.prepareSetup(
        options.provider ?? "codex",
      );
      if (requestId !== this.createRequestId) {
        return;
      }
      if (!prompt) {
        this.pending = false;
        this.patch();
        return;
      }

      const detail = await createTask({
        cwd: this.repository.rootPath,
        titleSource: prompt,
        ...options,
      });
      if (requestId !== this.createRequestId) {
        return;
      }
      const handoff = {
        detail,
        submission: {
          submissionId: `github:${Date.now()}:${requestId}`,
          prompt,
          images: [],
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
        throw new Error("The created Task could not take ownership of its prompt.");
      }
      this.pending = false;
      this.turnOptions().resetFastMode();
      this.dialog().close("started");
    } catch (error) {
      if (requestId !== this.createRequestId) {
        return;
      }
      this.pending = false;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.patch();
    }
  }

  handleClose() {
    if (this.pending) {
      return;
    }
    this.turnOptions()?.hidePopovers();
    const opener = this.opener;
    const restoreFocus = this.restoreFocus;
    this.opener = null;
    this.restoreFocus = true;
    if (restoreFocus && opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  render() {
    this.innerHTML = `
      <dialog
        closedby="any"
        aria-labelledby="github-task-start-title"
        aria-describedby="github-task-start-description"
      >
        <form class="github-task-start-card">
          <header>
            <h2 id="github-task-start-title"></h2>
            <p class="github-task-start-source-title"></p>
            <p id="github-task-start-description">
              Creates a Task and prepares a clean worktree. Work stops when ready.
            </p>
          </header>
          <div class="github-task-start-body">
            <caffold-github-issue-task-source hidden></caffold-github-issue-task-source>
            <caffold-github-pull-task-source hidden></caffold-github-pull-task-source>
            <caffold-task-turn-options></caffold-task-turn-options>
            <div class="github-task-start-error" aria-live="assertive"></div>
          </div>
          <footer>
            <button
              type="button"
              class="github-task-start-button"
              data-task-start-dialog-action="cancel"
            >Cancel</button>
            <button
              type="submit"
              class="github-task-start-button is-primary"
            >Start Task</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  patch() {
    const sourceComponent = this.sourceComponent();
    const source = sourceComponent?.source();
    if (!source || !this.repository?.rootPath) {
      return;
    }

    this.querySelector("#github-task-start-title").textContent =
      this.sourceKind === "pull"
        ? `Start Task for PR #${source.number}`
        : `Start Task for #${source.number}`;
    this.querySelector(".github-task-start-source-title").textContent = `${source.title ?? ""}`;
    const error = this.querySelector(".github-task-start-error");
    error.innerHTML = this.error
      ? `<p role="alert">${escapeHtml(this.error.message)}</p>`
      : "";
    this.querySelector('[data-task-start-dialog-action="cancel"]').disabled = this.pending;
    const submit = this.querySelector('button[type="submit"]');
    submit.disabled =
      this.pending ||
      !sourceComponent.readyForSubmission() ||
      !this.turnOptions().readyForSubmission();
    submit.textContent = this.pending ? "Starting..." : "Start Task";
    this.dialog().setAttribute("aria-busy", this.pending ? "true" : "false");
    sourceComponent.setLocked(this.pending);
    this.turnOptions().setContext({
      cwd: this.repository.rootPath,
      locked: this.pending,
      placement: "below",
    });
  }
}

function normalizeComposerSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return {
    model: `${settings.model ?? ""}`,
    effort: `${settings.effort ?? ""}`,
    fastMode: Boolean(settings.fastMode),
  };
}

if (!customElements.get("caffold-github-task-start-dialog")) {
  customElements.define("caffold-github-task-start-dialog", CaffoldGithubTaskStartDialog);
}
