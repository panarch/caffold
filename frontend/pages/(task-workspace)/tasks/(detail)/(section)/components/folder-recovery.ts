import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import type { ActionHintPull } from "#app/action-hints.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  getSectionDirectory,
  reconnectSectionFolder,
  type SectionDirectory,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import type {
  CaffoldTaskDirectoryField,
  DirectoryChosenDetail,
} from "#tasks/components/directory-field.js";
import "#tasks/components/directory-field.js";
import { scopedStyle } from "#app/scoped-style.js";
import {
  directoryPathDisplay,
  type ServerPaths,
} from "#tasks/components/directory-path.js";
import {
  initialRecoveryState,
  type RecoveryEvent,
  reduceRecovery,
} from "./folder-recovery/control.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import styles from "./folder-recovery.css.js";

export const SECTION_DIRECTORY_OBSERVED = "caffold:section-directory-observed";

@customElement("caffold-section-folder-recovery")
export class CaffoldSectionFolderRecovery extends CaffoldElement {
  static override styles = [
    scopedStyle(secondaryButton, ".recovery-action"),
    styles,
  ];
  private state = initialRecoveryState();
  private context: { id: string; path: string } | null = null;
  private server: ServerPaths = {};
  private active = false;
  private transport = true;
  private storeBlocked = false;
  private readonly field = new DrawnRef<CaffoldTaskDirectoryField>(this);
  private readonly hints = new ActionHints(this);

  setContext(
    context: { id: string; path: string } | null,
    server: ServerPaths,
  ) {
    const changed =
      this.context?.id !== context?.id || this.context?.path !== context?.path;
    this.context = context;
    this.server = server;
    if (changed) {
      this.dispatch({ type: "deactivate" });
      if (this.active && context) {
        this.check("activate");
      }
    }
    this.draw();
  }

  setAvailable(transport: boolean, storeBlocked: boolean) {
    const regained = transport && !this.transport;
    this.transport = transport;
    this.storeBlocked = storeBlocked;
    this.draw();
    if (regained && this.active) {
      if (this.state.phase === "editing") {
        this.check("recheck");
      }
      if (this.state.phase === "inactive") {
        this.check("activate");
      }
    }
  }

  activate() {
    this.active = true;
    void warmIcons().then(() => this.requestUpdate());
    if (this.state.phase === "inactive") {
      this.check("activate");
    }
  }

  deactivate() {
    this.active = false;
    this.field.value?.deactivate();
    this.dispatch({ type: "deactivate" });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hidden
      ? null
      : mergeActionHintScopes(
          this.hints.scope(pull),
          this.field.value?.actionHintScope(pull),
        );
  }

  scrollSurfaceScope(pull = {}) {
    return this.hidden
      ? emptyScrollSurfaceScope()
      : (this.field.value?.scrollSurfaceScope(pull) ??
          emptyScrollSurfaceScope());
  }

  ownsEditingEscape(element: Element | null) {
    return (
      !this.hidden && Boolean(this.field.value?.ownsEditingEscape(element))
    );
  }

  override render() {
    const { phase, directory, candidate, error } = this.state;
    const pending = phase === "checking" || phase === "submitting";
    const missing = directory?.directory.status === "missing";
    const reconnectReason = directory?.reconnectUnavailableReason;
    const inspectionMessage = missing ? null : directory?.directory.message;
    const disabled = pending || !this.transport || this.storeBlocked;
    const reconnectDisabled =
      disabled || candidate === null || Boolean(reconnectReason);

    return html`
      <header>
        <h2>
          <span class="recovery-icon-slot" aria-hidden="true">
            ${inlineIcon("CircleAlert", "", "recovery-icon")}
          </span>
          <span class="recovery-title">
            ${missing ? "Reconnect folder" : "Section folder unavailable"}
          </span>
        </h2>
        <p>
          ${
            missing
              ? "The original folder could not be found. Choose its current location."
              : "Check the Section folder before continuing."
          }
        </p>
      </header>
      <div class="recovery-body">
        <div class="previous">
          <span>Previous location</span>
          <p class="previous-path" title=${this.context?.path ?? ""}>
            ${directoryPathDisplay(this.context?.path ?? "", this.server)}
          </p>
        </div>
        ${
          missing
            ? html`
                <div class="new-location">
                  <span id="new-location-label">New location</span>
                  <caffold-task-directory-field
                    ${drawn(this.field)}
                    aria-labelledby="new-location-label"
                    @caffold:task-directory-chosen=${this.choose}
                  ></caffold-task-directory-field>
                </div>
                <p class="explanation">
                  Reconnect this Section and continue its Tasks in the selected folder.
                </p>
                ${
                  reconnectReason
                    ? html`<p class="reason">${reconnectReason}</p>`
                    : nothing
                }
              `
            : nothing
        }
        <p class="error" role="alert" ?hidden=${!error}>${error}</p>
        ${
          inspectionMessage
            ? html`<p class="reason">${inspectionMessage}</p>`
            : nothing
        }
        <div class="actions" aria-busy=${pending ? "true" : "false"}>
          <button
            type="button"
            class="recovery-action recheck"
            ${this.hints.button({
              id: "folder:recheck",
              label: "Check folder again",
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
            ?disabled=${disabled}
            @click=${() => this.check("recheck")}
          >Check again</button>
          ${
            missing
              ? html`
                  <button
                    type="button"
                    class="recovery-action reconnect"
                    ${this.hints.button({
                      id: "folder:reconnect",
                      label: "Reconnect folder",
                      action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                    })}
                    ?disabled=${reconnectDisabled}
                    @click=${this.submit}
                  >${phase === "submitting" ? "Reconnecting…" : "Reconnect folder"}</button>
                `
              : nothing
          }
          ${
            phase === "checking"
              ? html`<span role="status">Checking folder…</span>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  private dispatch(event: RecoveryEvent) {
    const next = reduceRecovery(this.state, event);
    if (next === this.state) {
      return false;
    }
    this.state = next;
    this.draw();
    return true;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.field.value?.setContext({
      path: this.state.candidate ?? this.state.directory?.browsePath ?? "",
      server: this.server,
      locked:
        this.state.phase !== "editing" || !this.transport || this.storeBlocked,
      dismissOnLeave: false,
    });
  }

  private choose(event: CustomEvent<DirectoryChosenDetail>) {
    event.stopPropagation();
    this.dispatch({ type: "choose", path: event.detail.path });
  }

  private check(type: "activate" | "recheck") {
    const context = this.context;
    if (!context || !this.transport || !this.dispatch({ type })) {
      return;
    }
    const generation = this.state.generation;
    void getSectionDirectory(context.id)
      .then((directory) => {
        if (!this.dispatch({ type: "checked", generation, directory })) {
          return;
        }
        this.observed(directory);
      })
      .catch((error: Error) =>
        this.dispatch({ type: "failed", generation, message: error.message }),
      );
  }

  private async submit() {
    const context = this.context;
    const candidate = this.state.candidate;
    if (
      !context ||
      candidate === null ||
      !this.transport ||
      this.storeBlocked ||
      !this.dispatch({ type: "submit" })
    ) {
      return;
    }
    let generation = this.state.generation;
    try {
      const directory = await reconnectSectionFolder(context.id, {
        expectedPath: context.path,
        path: candidate,
      });
      if (!this.dispatch({ type: "reconnected", generation, directory })) {
        return;
      }
      generation = this.state.generation;
      this.observed(directory);
      const canonical = await getSectionDirectory(context.id);
      if (
        this.dispatch({
          type: "checked",
          generation,
          directory: canonical,
        })
      ) {
        this.observed(canonical);
      }
    } catch (error) {
      this.dispatch({
        type: "failed",
        generation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private observed(directory: SectionDirectory) {
    this.dispatchEvent(
      new CustomEvent<SectionDirectory>(SECTION_DIRECTORY_OBSERVED, {
        bubbles: true,
        composed: true,
        detail: directory,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-section-folder-recovery": CaffoldSectionFolderRecovery;
  }
  interface HTMLElementEventMap {
    [SECTION_DIRECTORY_OBSERVED]: CustomEvent<SectionDirectory>;
  }
}
