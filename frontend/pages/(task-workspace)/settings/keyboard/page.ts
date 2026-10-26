import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  switchActionHintTarget,
} from "#app/action-hints.js";
import "#app/keyboard-navigation/components/shortcut-list.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
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
      <div class="settings-keyboard-scroll">
        <section class="settings-keyboard-section">
          <header>
            <p>Navigate Caffold with single keys when you are not typing.</p>
          </header>
          <label class="settings-keyboard-toggle">
            <span class="settings-keyboard-copy">
              <strong id="settings-action-hints-label">
                Keyboard navigation
              </strong>
              <span id="settings-action-hints-description">
                Enable keyboard shortcuts outside editing fields.
              </span>
            </span>
            <input
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
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const scrollport = this.querySelector(":scope > .settings-keyboard-scroll");
    const selector = "input[data-action-hints-enabled]";
    const control = this.querySelector<HTMLInputElement>(selector);
    if (
      this.hidden ||
      !scrollport ||
      !control ||
      !keyboardSwitchAvailable(control) ||
      !control.checked
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        switchActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:action-hints:disable`,
          actionId: ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE,
          label: "Turn keyboard navigation off",
          control,
          anchor: control.closest("label") ?? control,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(selector) === control &&
            keyboardSwitchAvailable(control) &&
            control.checked,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:keyboard",
    label = "Keyboard settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-keyboard-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(":scope > .settings-keyboard-scroll") ===
              scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private toggle(event: Event) {
    setActionHintsEnabled((event.target as HTMLInputElement).checked);
  }
}

function keyboardSwitchAvailable(control: HTMLInputElement) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
}

customElements.define(
  "caffold-settings-keyboard-page",
  CaffoldSettingsKeyboardPage,
);
