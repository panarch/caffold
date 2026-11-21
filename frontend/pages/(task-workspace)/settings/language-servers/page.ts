import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type {
  LanguageServerFailure,
  LanguageServerLanguage,
  LanguageServerStatus,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import { languageServerMemory } from "../../language-servers.js";
import {
  LanguageSettingsLifecycle,
  type LanguageSettingsSnapshot,
  RunningServersLifecycle,
  type RunningServersSnapshot,
} from "./lifecycle.js";

import switchStyle from "#app/component-styles/switch.css.js";
import styles from "./page.css.js";

const INTRO =
  "Language servers answer Go to definition and Find references in the code viewers. Turn a language on here, then turn language servers on for a repository in Task details, which also offers to install a missing server.";

/**
 * Settings → Language Servers: each language's switch, and the servers
 * running for repositories, with their memory.
 */
@customElement("caffold-settings-language-servers-page")
export class CaffoldSettingsLanguageServersPage extends CaffoldElement {
  @state()
  private accessor languages: LanguageSettingsSnapshot;
  @state()
  private accessor running: RunningServersSnapshot;

  static override styles = [
    scopedStyle(switchStyle, ".settings-language-server-switch"),
    styles,
  ];

  private readonly languagesLifecycle = new LanguageSettingsLifecycle({
    onChange: (snapshot) => {
      this.languages = snapshot;
    },
  });
  private readonly runningLifecycle = new RunningServersLifecycle({
    onChange: (snapshot) => {
      this.running = snapshot;
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.languages = this.languagesLifecycle.snapshot;
    this.running = this.runningLifecycle.snapshot;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  activate() {
    this.languagesLifecycle.activate();
    this.runningLifecycle.activate();
  }

  deactivate() {
    this.languagesLifecycle.deactivate();
    this.runningLifecycle.deactivate();
  }

  actionHintScope({
    scopeId = "settings:language-servers",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:language-servers",
    label = "Language Servers settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  override render() {
    const languages = this.languages;
    const running = this.running;
    const servers = running.running?.servers ?? [];
    const total = running.running
      ? languageServerMemory(running.running.totalMemoryBytes)
      : "";
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-content-scroll"
      >
        <div class="settings-content-section">
          <header>
            <p>${INTRO}</p>
          </header>
          <section
            aria-labelledby="settings-language-servers-languages-title"
            aria-busy=${String(languages.busy)}
          >
            <h3 id="settings-language-servers-languages-title">Languages</h3>
            ${
              languages.languages === null && languages.busy
                ? html`<caffold-loading-text
                    >Reading languages…</caffold-loading-text
                  >`
                : nothing
            }
            <p
              class="settings-language-servers-message"
              role="alert"
              ?hidden=${!languages.message}
            >${languages.message}</p>
            <button
              ${this.hints.button({
                id: "retry-languages",
                label: "Retry reading languages",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                when: languages.retry,
              })}
              type="button"
              class="settings-language-servers-button"
              data-action="retry-languages"
              ?hidden=${!languages.retry}
              @click=${() => this.languagesLifecycle.retry()}
            >Retry</button>
            <ul class="settings-language-servers-list">
              ${(languages.languages ?? []).map(
                ({ id, name, serverName, enabled: saved }) => {
                  const enabled =
                    languages.saving?.language === id
                      ? languages.saving.enabled
                      : saved;
                  return html`<li class="settings-language-server" data-language=${id}>
                  <label class="settings-language-server-toggle">
                    <span class="settings-language-server-copy">
                      <strong id=${`settings-language-server-${id}-name`}>${name}</strong>
                      <span id=${`settings-language-server-${id}-server`}>${serverName}</span>
                    </span>
                    <input
                      ${this.hints.switch({
                        id: `language:${id}`,
                        label: enabled ? `Turn ${name} off` : `Turn ${name} on`,
                        action: ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE,
                      })}
                      type="checkbox"
                      role="switch"
                      class="settings-language-server-switch"
                      aria-labelledby=${`settings-language-server-${id}-name`}
                      aria-describedby=${`settings-language-server-${id}-server`}
                      data-language=${id}
                      .checked=${live(enabled)}
                      ?disabled=${!languages.ready}
                      @change=${this.toggleLanguage}
                    >
                  </label>
                </li>`;
                },
              )}
            </ul>
          </section>
          <section
            aria-labelledby="settings-language-servers-running-title"
            data-running
          >
            <h3 id="settings-language-servers-running-title">${
              servers.length > 0 ? `Running · ${total} in total` : "Running"
            }</h3>
            <p
              class="settings-language-servers-message"
              role="alert"
              ?hidden=${!running.message}
            >${running.message}</p>
            <p
              class="settings-language-servers-none"
              ?hidden=${!running.running || servers.length > 0}
            >None.</p>
            <ul class="settings-language-servers-list">
              ${servers.map((server) => {
                const path = server.repositoryPath;
                const title = server.repositoryBranch || folderName(path);
                return html`<li
                  class="settings-language-server-running"
                  data-repository=${path}
                  data-language=${server.language}
                >
                  <span class="settings-language-server-copy">
                    <strong>${title}</strong>
                    <span>${[
                      server.languageName,
                      runningState(server),
                      languageServerMemory(server.memoryBytes),
                    ]
                      .filter(Boolean)
                      .join(" · ")}</span>
                    <input
                      ${this.hints.textbox({
                        id: `repository-path:${server.language}:${path}`,
                        label: `Focus the path of ${title}`,
                        action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
                      })}
                      class="settings-language-server-path"
                      type="text"
                      readonly
                      aria-label=${`Path of ${title}`}
                      spellcheck="false"
                      .value=${live(path)}
                    >
                  </span>
                  <button
                    ${this.hints.button({
                      id: `turn-off:${server.language}:${path}`,
                      label: `Turn off language servers in ${title}`,
                      action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      when: running.stopping === null,
                    })}
                    type="button"
                    class="settings-language-servers-button"
                    data-action="turn-off-repository"
                    data-repository=${path}
                    ?disabled=${running.stopping !== null}
                    @click=${this.turnOffRepository}
                  >${running.stopping === path ? "Turning off..." : "Turn off"}</button>
                </li>`;
              })}
            </ul>
          </section>
        </div>
      </div>
    `;
  }

  private async toggleLanguage(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const saved = await this.languagesLifecycle.setEnabled(
      input.dataset.language as LanguageServerLanguage,
      input.checked,
    );
    if (saved) {
      this.runningLifecycle.refresh();
    }
  }

  private turnOffRepository(event: Event) {
    const path = (event.currentTarget as HTMLButtonElement).dataset.repository;
    if (path !== undefined) {
      void this.runningLifecycle.turnOff(path);
    }
  }
}

function runningState(server: LanguageServerStatus) {
  switch (server.state) {
    case "starting":
      return server.progress
        ? `Getting ready · ${server.progress}`
        : "Getting ready";
    case "ready":
      return "Ready";
    case "sleeping":
      return "Sleeping";
    case "failed":
      return failedState(server.failure);
    default:
      return "Off";
  }
}

function failedState(failure: LanguageServerFailure | undefined) {
  switch (failure?.kind) {
    case "notInstalled":
      return failure.toolchain
        ? `Not installed for the ${failure.toolchain} toolchain`
        : "Not installed";
    case "couldNotStart":
      return "Could not start";
    case "stopped":
      return "Stopped";
    default:
      return "Failed";
  }
}

function folderName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? (path || ".");
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-language-servers-page": CaffoldSettingsLanguageServersPage;
  }
}
