import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { RunnerStatus } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "./runtime/components/runtime-restart-dialog.js";
import type { CaffoldSettingsRuntimeRestartDialog } from "./runtime/components/runtime-restart-dialog.js";
import "./detail-list.js";
import type { SettingsDetailRow } from "./detail-list.js";

import styles from "./runtime.css.js";

@customElement("caffold-settings-runtime")
export class CaffoldSettingsRuntime extends CaffoldElement {
  static override styles = styles;
  @property() accessor agentName = "Claude";
  @property() accessor description = "";
  @property({ attribute: false }) accessor rows: SettingsDetailRow[] = [];
  @property({ type: Boolean }) accessor disabled = false;
  @property({ type: Boolean }) accessor restarting = false;
  @property() accessor message = "";
  @property({ type: Boolean }) accessor failed = false;
  private readonly hints = new ActionHints(this);
  private readonly dialog = new DrawnRef<CaffoldSettingsRuntimeRestartDialog>(
    this,
  );

  override render() {
    return html`
      <div class="settings-runtime-control">
        <div><h3>Runtime</h3><p data-runtime-summary>${this.description}</p></div>
        <button
          ${this.hints.button({ id: "restart-runtime", label: "Restart runtime", action: ACTION_HINT_ACTION.BUTTON_ACTIVATE })}
          type="button" ?disabled=${this.disabled || this.restarting}
          @click=${() => this.dialog.value?.open()}
        >${this.restarting ? "Restarting…" : "Restart runtime"}</button>
      </div>
      <caffold-settings-detail-list .rows=${this.rows}></caffold-settings-detail-list>
      <p class="settings-runtime-message" role="status" data-state=${this.failed ? "failed" : "success"} ?hidden=${!this.message}>${this.message}</p>
      <caffold-settings-runtime-restart-dialog ${drawn(this.dialog)} .agentName=${this.agentName}
        @caffold:runtime-restart-confirmed=${(event: Event) => {
          if (this.disabled || this.restarting) event.stopPropagation();
        }}
      ></caffold-settings-runtime-restart-dialog>`;
  }
  close() {
    this.dialog.value?.close();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.close();
  }
  keyboardNavigationContexts() {
    return this.dialog.value?.keyboardNavigationContexts() ?? [];
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }
}

export function runnerStatusRows(runtime?: RunnerStatus): SettingsDetailRow[] {
  if (!runtime) return [{ key: "runner", label: "Runner" }];
  if (runtime.running === null)
    return [
      {
        key: "runner",
        label: "Runner",
        value: `Unavailable${runtime.error ? ` — ${runtime.error}` : ""}`,
        state: "negative",
      },
    ];
  if (!runtime.running)
    return [{ key: "runner", label: "Runner", value: "Not running" }];
  return [
    { key: "runner", label: "Runner", value: `Running · pid ${runtime.pid}` },
    { key: "sessions", label: "Sessions", value: String(runtime.sessions) },
    {
      key: "runner-build",
      label: "Runner build",
      value: runtime.version,
      kind: "code",
    },
    ...(runtime.idleTimeoutSecs !== null
      ? [
          {
            key: "idle-timeout",
            label: "Idle timeout",
            value:
              runtime.idleTimeoutSecs < 60
                ? `${runtime.idleTimeoutSecs}s`
                : `${Math.round(runtime.idleTimeoutSecs / 60)} min`,
          },
        ]
      : []),
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-runtime": CaffoldSettingsRuntime;
  }
}
