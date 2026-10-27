import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import styles from "./item.css.js";

export interface SettingsNavigatorIntentDetail {
  section: string;
}

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
@customElement("caffold-settings-navigator-item")
export class CaffoldSettingsNavigatorItem extends CaffoldElement {
  @property({ attribute: false })
  accessor entry: SettingsNavigatorEntry | null = null;
  @property({ attribute: false })
  accessor selected = false;
  // A newer release exists, or this window has a new build to load.
  @property({ attribute: false })
  accessor updateAvailable = false;
  @property({ attribute: false })
  accessor reloadReady = false;

  static override styles = styles;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  get section() {
    return this.entry?.section ?? "";
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
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
      new CustomEvent<SettingsNavigatorIntentDetail>(
        "caffold:settings-navigator-intent",
        {
          bubbles: true,
          composed: true,
          detail: { section: this.section },
        },
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-navigator-item": CaffoldSettingsNavigatorItem;
  }

  interface HTMLElementEventMap {
    "caffold:settings-navigator-intent": CustomEvent<SettingsNavigatorIntentDetail>;
  }
}
