import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "#app/keyboard-navigation/components/shortcut-list.ts";
import {
  getSettings,
  type Settings,
  setActionHintsEnabled,
} from "#app/settings.ts";

export class CaffoldSettingsKeyboardPage extends LitElement {
  static properties = {
    settings: { state: true },
  };

  declare private settings: Settings;
  private readonly settingsChanged = (event: Event) => {
    this.settings =
      (event as CustomEvent<{ settings?: Settings }>).detail?.settings ??
      getSettings();
  };
  private readonly hints: ActionHints = new ActionHints(
    this,
    () => this.performUpdate(),
    { clipRoots: () => [this, this.scrollport.value] },
  );
  private readonly surfaces = new ScrollSurfaces(this, () =>
    this.performUpdate(),
  );
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly toggleLabel = new DrawnRef<HTMLLabelElement>(this);

  constructor() {
    super();
    this.settings = getSettings();
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:settings-change", this.settingsChanged);
    this.settings = getSettings();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:settings-change", this.settingsChanged);
  }

  prepareRoute() {
    this.settings = getSettings();
  }

  render() {
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

customElements.define(
  "caffold-settings-keyboard-page",
  CaffoldSettingsKeyboardPage,
);
