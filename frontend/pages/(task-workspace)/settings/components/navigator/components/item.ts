import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";

// The section an entry opens, its label, and either an icon or a brand mark.
export interface SettingsNavigatorEntry {
  section: string;
  label: string;
  icon?: string;
  brand?: string;
}

// One Settings section in the Settings navigator. A late icon, the selection,
// and an update notice change this entry's own button, so the list around it
// keeps its scroll position and focus.
export class CaffoldSettingsNavigatorItem extends LitElement {
  static properties = {
    entry: { attribute: false },
    selected: { attribute: false },
    updateAvailable: { attribute: false },
    reloadReady: { attribute: false },
  };

  declare entry: SettingsNavigatorEntry | null;
  declare selected: boolean;
  // A newer release exists, or this window has a new build to load.
  declare updateAvailable: boolean;
  declare reloadReady: boolean;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  constructor() {
    super();
    this.entry = null;
    this.selected = false;
    this.updateAvailable = false;
    this.reloadReady = false;
  }

  get section() {
    return this.entry?.section ?? "";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const entry = this.entry;
    if (!entry) {
      return nothing;
    }
    const notices = [
      this.updateAvailable && "update available",
      this.reloadReady && "reload to update",
    ].filter(Boolean);
    const label =
      notices.length > 0 ? `${entry.label} — ${notices.join(", ")}` : "";
    const mark = entry.brand
      ? html`<img
          class="settings-navigator-item-brand"
          src=${`/assets/brand/${entry.brand}`}
          alt=""
        />`
      : html`<span class="settings-navigator-item-icon-slot">${inlineIcon(
          entry.icon ?? "",
          "",
          "settings-navigator-item-icon",
        )}</span>`;
    return html`
      <button
        ${this.hints.button({
          id: `section:${entry.section}`,
          label: label || `Open ${entry.label} settings`,
          action: ACTION_HINT_ACTION.SETTINGS_SECTION,
          when: !this.selected,
        })}
        type="button"
        data-settings-section=${entry.section}
        ?aria-current=${this.selected}
        ?data-update-available=${notices.length > 0}
        aria-label=${label || nothing}
        @click=${this.open}
      >
        ${mark}
        <span class="settings-navigator-item-label">${entry.label}</span>
      </button>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private open() {
    this.dispatchEvent(
      new CustomEvent("caffold:settings-navigator-intent", {
        bubbles: true,
        detail: { section: this.section },
      }),
    );
  }
}

customElements.define(
  "caffold-settings-navigator-item",
  CaffoldSettingsNavigatorItem,
);
