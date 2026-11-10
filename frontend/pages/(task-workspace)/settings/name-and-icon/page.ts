import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { serverIconUrl } from "#app/server-identity.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import {
  ServerSettingsLifecycle,
  type ServerSettingsSnapshot,
} from "./lifecycle.js";

import styles from "./page.css.js";

@customElement("caffold-settings-name-and-icon-page")
export class CaffoldSettingsNameAndIconPage extends CaffoldElement {
  @state()
  private accessor snapshot: ServerSettingsSnapshot = {
    settings: null,
    ready: false,
    busy: false,
    retry: false,
    message: "",
  };
  // The name as typed and not yet saved. While there is none, the field shows
  // the saved name.
  @state()
  private accessor draft: string | null = null;

  static override styles = styles;

  private active = false;
  private readonly lifecycle = new ServerSettingsLifecycle({
    onChange: (snapshot) => {
      this.snapshot = snapshot;
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly iconLabels = new DrawnRefs<HTMLLabelElement>(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.lifecycle.activate();
  }

  deactivate() {
    this.active = false;
    this.draft = null;
    this.lifecycle.deactivate();
  }

  override render() {
    const { settings, ready, busy, retry, message } = this.snapshot;
    const name = this.draft ?? settings?.name ?? "";
    const typed = name.trim();
    const changed =
      this.draft !== null && typed !== "" && typed !== settings?.name;
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-content-scroll"
      >
        <div class="settings-content-section" aria-busy=${String(busy)}>
          <header>
            <div>
              <p>
                Name this host and choose its icon. Browser tabs, installed
                apps, and notifications show them, so this host can be told
                apart from another.
              </p>
              <p>
                Apps installed earlier keep the name and icon they were
                installed with until you install them again.
              </p>
            </div>
            <button
              ${this.hints.button({
                id: "retry",
                label: "Retry loading the name and icon",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="retry"
              ?hidden=${!retry}
              @click=${() => this.lifecycle.retry()}
            >Retry</button>
          </header>
          <p
            class="settings-name-and-icon-message"
            role="alert"
            ?hidden=${!message}
          >${message}</p>
          <form class="settings-field" @submit=${this.saveName}>
            <label
              class="settings-field-label"
              for="settings-server-name"
            >Name</label>
            <div class="settings-name-control">
              <input
                ${this.hints.textbox({
                  id: "name",
                  label: "Focus Name",
                  action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
                })}
                id="settings-server-name"
                name="name"
                autocomplete="off"
                spellcheck="false"
                .value=${live(name)}
                ?disabled=${!ready}
                @input=${(event: Event) => {
                  this.draft = (event.target as HTMLInputElement).value;
                }}
              >
              <button
                ${this.hints.button({
                  id: "save-name",
                  label: "Save the name",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="submit"
                data-action="save-name"
                ?disabled=${!ready || !changed}
              >Save</button>
            </div>
          </form>
          <div class="settings-field">
            <span
              class="settings-field-label"
              id="settings-server-icon-label"
            >Icon</span>
            <fieldset
              class="settings-icon-choices"
              aria-labelledby="settings-server-icon-label"
            >
              <legend class="sr-only">Icon</legend>
              ${(settings?.icons ?? []).map(
                (icon) => html`
                  <label
                    ${drawn(this.iconLabels.of(icon.id))}
                    title=${icon.label}
                  >
                    <input
                      ${this.hints.radio({
                        id: `icon:${icon.id}`,
                        label: `Use the ${icon.label} icon`,
                        action: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
                        when: icon.id !== settings?.icon,
                        anchor: () => this.iconLabels.get(icon.id),
                      })}
                      type="radio"
                      name="server-icon"
                      value=${icon.id}
                      aria-label=${icon.label}
                      .checked=${live(icon.id === settings?.icon)}
                      ?disabled=${!ready}
                      @change=${this.chooseIcon}
                    >
                    <img src=${serverIconUrl(icon.id, "icon-192.png")} alt="">
                  </label>
                `,
              )}
            </fieldset>
          </div>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:name-and-icon",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:name-and-icon",
    label = "Name and icon settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  // An icon the server did not save leaves its radio checked until the next
  // render puts the saved one back.
  private async chooseIcon(event: Event) {
    const choice = event.currentTarget as HTMLInputElement;
    if (!choice.checked) return;
    if (!(await this.lifecycle.saveIcon(choice.value))) {
      this.requestUpdate();
    }
  }

  private async saveName(event: Event) {
    event.preventDefault();
    const name = this.draft?.trim();
    if (!name || name === this.snapshot.settings?.name) return;
    if (await this.lifecycle.saveName(name)) {
      this.draft = null;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-name-and-icon-page": CaffoldSettingsNameAndIconPage;
  }
}
