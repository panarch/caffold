import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "../components/detail-list.js";
import {
  type JevSettings,
  JevSettingsLifecycle,
  type JevSettingsSnapshot,
} from "./lifecycle.js";

@customElement("caffold-settings-jev-page")
export class CaffoldSettingsJevPage extends LitElement {
  @state()
  private accessor snapshot: JevSettingsSnapshot = {
    settings: null,
    fresh: false,
    busy: false,
    retry: false,
    message: "",
  };

  private active = false;
  // A half-written rule is the person's, not the server's. While one is being
  // typed the saved value stops being written back over it.
  private editing = false;
  private announcedAvailability: boolean | null = null;
  private readonly lifecycle = new JevSettingsLifecycle({
    onChange: (snapshot) => {
      this.snapshot = snapshot;
      this.announceAvailability(snapshot.settings);
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly criteria = new DrawnRef<HTMLTextAreaElement>(this);
  private readonly key = new DrawnRef<HTMLInputElement>(this);

  override createRenderRoot() {
    return this;
  }

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
    this.lifecycle.deactivate();
  }

  override render() {
    const { settings, fresh, busy, retry, message } = this.snapshot;
    const locked = busy || !fresh || !settings;
    const saved = Boolean(settings?.keyConfigured);
    const rows = [
      { key: "model", label: "Model", value: settings?.model, kind: "code" },
      {
        key: "api-key",
        label: "API key",
        value: settings ? (saved ? "Saved" : "Not saved") : undefined,
      },
      { key: "check", label: "Last check", value: lastCheckSummary(settings) },
    ] as const;
    const placeholder = saved ? "Enter a new key to replace the saved one" : "";
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
            <div>
              <p id="settings-jev-description">
                Jev holds back only the permission requests an automatic mode
                would stop for, so the rest never reaches you. A Task uses it
                when its composer chooses Ask Jev first.
              </p>
              <p id="settings-jev-note">
                Under that mode each request is sent to TypeSafe with these
                rules. Under every other mode nothing leaves this Mac.
              </p>
            </div>
            <button
              ${this.hints.button({
                id: "refresh",
                label: "Retry loading Jev settings",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="refresh"
              ?hidden=${!retry}
              @click=${this.refresh}
            >Retry</button>
          </header>
          <p
            class="settings-jev-message"
            role="alert"
            ?hidden=${!message}
          >${message}</p>
          <caffold-settings-detail-list
            .rows=${rows}
          ></caffold-settings-detail-list>
          <form
            class="settings-jev-criteria"
            data-jev-form="criteria"
            @submit=${this.saveCriteria}
          >
            <label for="settings-jev-criteria">Extra rules</label>
            <p id="settings-jev-criteria-note">
              Optional. Jev already judges to the standard of a coding agent's
              automatic permission mode. Write here only what you want to add to
              that, or take away from it.
            </p>
            <textarea
              ${drawn(this.criteria)}
              ${this.hints.textbox({
                id: "criteria",
                label: "Focus Extra rules",
                action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
              })}
              id="settings-jev-criteria"
              name="criteria"
              rows="8"
              spellcheck="false"
              aria-describedby="settings-jev-criteria-note"
              ?disabled=${locked}
              @input=${this.startEditing}
            ></textarea>
            <div class="settings-jev-actions">
              <button
                ${this.hints.button({
                  id: "save-criteria",
                  label: "Save the extra rules",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="submit"
                ?disabled=${locked}
              >Save extra rules</button>
            </div>
          </form>
          <form
            class="settings-jev-key"
            data-jev-form="key"
            @submit=${this.saveKey}
          >
            <label for="settings-jev-key">${
              saved ? "Replace API key" : "API key"
            }</label>
            <div class="settings-jev-key-row">
              <input
                ${drawn(this.key)}
                ${this.hints.textbox({
                  id: "key",
                  label: `Focus ${saved ? "Replace API key" : "API key"}`,
                  action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
                })}
                id="settings-jev-key"
                name="key"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder=${placeholder}
                ?disabled=${locked}
              >
              <button
                ${this.hints.button({
                  id: "save-key",
                  label: "Save the Jev API key",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="submit"
                ?disabled=${locked}
              >Save key</button>
              <button
                ${this.hints.button({
                  id: "remove-key",
                  label: "Remove the Jev API key",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="remove-key"
                ?hidden=${!saved}
                ?disabled=${locked}
                @click=${this.removeKey}
              >Remove key</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  override updated() {
    const settings = this.snapshot.settings;
    const textarea = this.criteria.value;
    if (!this.editing && settings && textarea) {
      textarea.value = settings.criteria;
    }
  }

  actionHintScope({ scopeId = "settings:jev", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:jev",
    label = "Jev Permissions settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  /**
   * Composers stay mounted while Settings is open, and the mode they offer is
   * withheld until a key exists. They are told when that answer changes so they
   * ask for their list again instead of going on offering a mode that is now
   * usable, or one that no longer is.
   */
  private announceAvailability(settings: JevSettings | null) {
    if (!settings) return;
    const available = settings.keyConfigured;
    if (available === this.announcedAvailability) return;
    this.announcedAvailability = available;
    window.dispatchEvent(new CustomEvent("caffold:jev-settings-changed"));
  }

  private refresh() {
    void this.lifecycle.refresh();
  }

  private removeKey() {
    void this.lifecycle.removeKey();
  }

  private startEditing() {
    this.editing = true;
  }

  private async saveCriteria(event: Event) {
    event.preventDefault();
    const textarea = this.criteria.value;
    if (!textarea) return;
    if (await this.lifecycle.saveCriteria(textarea.value)) {
      this.editing = false;
      this.requestUpdate();
    }
  }

  private async saveKey(event: Event) {
    event.preventDefault();
    const input = this.key.value;
    if (!input) return;
    if (await this.lifecycle.storeKey(input.value)) {
      input.value = "";
    }
  }
}

function lastCheckSummary(settings: JevSettings | null) {
  if (!settings) return undefined;
  if (!settings.keyConfigured) return "No key to check";
  const check = settings.lastCheck;
  if (!check) return "Not checked since Caffold started";
  return check.ok
    ? `Answered by ${check.model ?? settings.model}`
    : (check.message ?? "The key did not work.");
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-jev-page": CaffoldSettingsJevPage;
  }
}
