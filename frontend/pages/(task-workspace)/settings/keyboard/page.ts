import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#app/keyboard-navigation/components/shortcut-list.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { SettingsChangeDetail } from "#app/settings.js";
import {
  getSettings,
  type Settings,
  setActionHintsEnabled,
} from "#app/settings.js";

import styles from "./page.css.js";

@customElement("caffold-settings-keyboard-page")
export class CaffoldSettingsKeyboardPage extends CaffoldElement {
  @state()
  private accessor settings: Settings = getSettings();

  static override styles = styles;

  private readonly settingsChanged = (
    event: CustomEvent<SettingsChangeDetail>,
  ) => {
    this.settings = event.detail?.settings ?? getSettings();
  };
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly toggleLabel = new DrawnRef<HTMLLabelElement>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:settings-change", this.settingsChanged);
    this.settings = getSettings();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:settings-change", this.settingsChanged);
  }

  prepareRoute() {
    this.settings = getSettings();
  }

  override render() {
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-keyboard-scroll"
      >
        <section class="settings-keyboard-section">
          <header>
            <p>Navigate Caffold with single keys when you are not typing.</p>
          </header>
          <label ${drawn(this.toggleLabel)} class="settings-keyboard-toggle">
            <span class="settings-keyboard-copy">
              <strong id="settings-action-hints-label">
                Keyboard navigation
              </strong>
              <span id="settings-action-hints-description">
                Enable keyboard shortcuts outside editing fields.
              </span>
            </span>
            <input
              ${this.hints.switch({
                id: "action-hints:disable",
                label: "Turn keyboard navigation off",
                action: ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE,
                when: this.settings.actionHintsEnabled !== false,
                anchor: () => this.toggleLabel.value,
              })}
              type="checkbox"
              role="switch"
              data-action-hints-enabled
              aria-labelledby="settings-action-hints-label"
              aria-describedby="settings-action-hints-description"
              .checked=${this.settings.actionHintsEnabled !== false}
              @change=${this.toggle}
            >
            <span class="settings-keyboard-state" aria-hidden="true"></span>
          </label>
          <section
            class="settings-keyboard-shortcuts"
            aria-labelledby="settings-keyboard-shortcuts-title"
          >
            <header>
              <h2 id="settings-keyboard-shortcuts-title">
                Keyboard shortcuts
              </h2>
              <p>
                Single keys need Keyboard navigation on; key combinations
                always work.
              </p>
            </header>
            <caffold-keyboard-shortcut-list></caffold-keyboard-shortcut-list>
          </section>
        </section>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:keyboard",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:keyboard",
    label = "Keyboard settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private toggle(event: Event) {
    setActionHintsEnabled((event.target as HTMLInputElement).checked);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-keyboard-page": CaffoldSettingsKeyboardPage;
  }
}
