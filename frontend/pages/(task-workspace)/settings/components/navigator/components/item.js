import { renderInlineIcon, warmIcons } from "#components/icons.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";

// One Settings section in the Settings navigator. A late icon, the selection,
// and an update notice patch this entry's own button, so the list around it
// keeps its scroll position and focus.
class CaffoldSettingsNavigatorItem extends HTMLElement {
  constructor() {
    super();
    this.entry = null;
    this.selected = false;
    this.updateAvailable = false;
    this.reloadReady = false;
    this.connected = false;
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.renderIcon();
  }

  connectedCallback() {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.renderIcon();
    warmIcons();
  }

  disconnectedCallback() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  get section() {
    return this.entry?.section ?? "";
  }

  // The section this entry opens, its label, and either an icon or a brand
  // mark.
  setEntry(entry) {
    this.entry = entry;
    this.innerHTML = `
      <button type="button" data-settings-section="${entry.section}">
        ${entry.brand
          ? `<img class="settings-navigator-item-brand" src="/assets/brand/${entry.brand}" alt="" />`
          : `<span class="settings-navigator-item-icon-slot"></span>`}
        <span class="settings-navigator-item-label">${entry.label}</span>
      </button>
    `;
    this.renderIcon();
    this.syncSelected();
    this.syncUpdateNotice();
  }

  setSelected(selected) {
    this.selected = selected;
    this.syncSelected();
  }

  // Only the About entry shows that Caffold has an update: a newer release, or
  // a new build this window can load.
  setUpdateNotice({ updateAvailable = false, reloadReady = false } = {}) {
    this.updateAvailable = updateAvailable === true;
    this.reloadReady = reloadReady === true;
    this.syncUpdateNotice();
  }

  handleClick(event) {
    const control = this.button();
    if (!control || event.target.closest?.("button") !== control) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:settings-navigator-intent", {
        bubbles: true,
        detail: { section: this.section },
      }),
    );
  }

  actionHintScope({
    scopeId = "settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const control = this.button();
    if (!this.entry || !control || this.selected) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:section:${this.entry.section}`,
        actionId: ACTION_HINT_ACTION.SETTINGS_SECTION,
        label: control.getAttribute("aria-label") ||
          `Open ${this.entry.label} settings`,
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          isCurrent() &&
          !this.selected &&
          this.button() === control,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  renderIcon() {
    const slot = this.querySelector(
      ":scope > button > .settings-navigator-item-icon-slot",
    );
    if (slot && !slot.querySelector(":scope > .settings-navigator-item-icon")) {
      slot.innerHTML = renderInlineIcon(
        this.entry.icon,
        "",
        "settings-navigator-item-icon",
      );
    }
  }

  syncSelected() {
    this.button()?.toggleAttribute("aria-current", this.selected);
  }

  syncUpdateNotice() {
    const button = this.button();
    if (!button || !this.entry) {
      return;
    }
    const notices = [
      this.updateAvailable && "update available",
      this.reloadReady && "reload to update",
    ].filter(Boolean);
    button.toggleAttribute("data-update-available", notices.length > 0);
    if (notices.length > 0) {
      button.setAttribute("aria-label", `${this.entry.label} — ${notices.join(", ")}`);
    } else {
      button.removeAttribute("aria-label");
    }
  }

  button() {
    return this.querySelector(":scope > button");
  }
}

customElements.define(
  "caffold-settings-navigator-item",
  CaffoldSettingsNavigatorItem,
);
