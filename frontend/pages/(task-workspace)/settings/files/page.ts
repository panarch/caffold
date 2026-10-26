import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import {
  FILE_SORT_MODES,
  getSettings,
  type Settings,
  setFileSortMode,
} from "#app/settings.ts";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.ts";

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
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly optionLabels = new DrawnRefs<HTMLLabelElement>(this);

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
        <label ${drawn(this.optionLabels.of(option.value))}>
          <input
            ${this.hints.radio({
              id: `sort:${option.value}`,
              label: `Use ${option.label} ordering`,
              action: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
              when: option.value !== this.settings.fileSortMode,
              anchor: () => this.optionLabels.get(option.value),
            })}
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
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-files-scroll"
      >
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
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:files",
    label = "File settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }
}

customElements.define("caffold-settings-files-page", CaffoldSettingsFilesPage);
