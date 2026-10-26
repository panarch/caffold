import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  radioActionHintTarget,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import {
  FILE_SORT_MODES,
  getSettings,
  type Settings,
  setFileSortMode,
} from "#app/settings.js";

const SORT_OPTIONS = Object.freeze([
  Object.freeze({
    value: FILE_SORT_MODES.FOLDERS_FIRST,
    label: "Folders first",
    description: "Show folders before files and other entries.",
  }),
  Object.freeze({
    value: FILE_SORT_MODES.NAME,
    label: "All entries by name",
    description: "Mix folders, files, and other entries using their names.",
  }),
]);

export class CaffoldSettingsFilesPage extends LitElement {
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
    const options = SORT_OPTIONS.map(
      (option) => html`
        <label>
          <input
            type="radio"
            name="settings-file-sort-mode"
            value=${option.value}
            data-file-sort-mode
            .checked=${option.value === this.settings.fileSortMode}
            @change=${() => setFileSortMode(option.value)}
          >
          <span class="settings-files-option-copy">
            <strong>${option.label}</strong>
            <span>${option.description}</span>
          </span>
        </label>
      `,
    );
    return html`
      <div class="settings-files-scroll">
        <section class="settings-files-section">
          <header>
            <p id="settings-files-description">
              Choose how Caffold orders shared file trees in this browser.
            </p>
          </header>
          <fieldset
            class="settings-files-options"
            aria-describedby="settings-files-description"
          >
            <legend class="sr-only">File tree ordering</legend>
            ${options}
          </fieldset>
        </section>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:files",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const scrollport = this.querySelector(":scope > .settings-files-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const targetClipRoots = [this, scrollport, ...clipRoots].filter(Boolean);
    const targets = SORT_OPTIONS.flatMap((option) => {
      const selector = `input[type="radio"][data-file-sort-mode][value="${option.value}"]`;
      const control = this.querySelector<HTMLInputElement>(selector);
      if (!control || !fileSortControlAvailable(control) || control.checked) {
        return [];
      }
      return [
        radioActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:sort:${option.value}`,
          actionId: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
          label: `Use ${option.label} ordering`,
          control,
          anchor: control.closest("label") ?? control,
          clipRoots: targetClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(selector) === control &&
            fileSortControlAvailable(control) &&
            !control.checked,
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:files",
    label = "File settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-files-scroll");
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
            this.querySelector(":scope > .settings-files-scroll") ===
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
}

function fileSortControlAvailable(control: HTMLInputElement) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
}

customElements.define("caffold-settings-files-page", CaffoldSettingsFilesPage);
