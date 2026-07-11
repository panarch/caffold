import { renderInlineIcon, warmIcons } from "../../components/icons.js";

const POPOVER_ID = "caffold-app-menu-popover";

class CaffoldAppMenu extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => this.handleClick(event));
    this.boundIconsReady = () => this.renderKeepingPopover();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "open-settings") {
      this.closePopover();
      this.dispatchEvent(
        new CustomEvent("caffold:open-settings", {
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  closePopover() {
    this.querySelector(".app-menu-popover")?.hidePopover?.();
  }

  renderKeepingPopover() {
    const wasOpen = this.querySelector(".app-menu-popover")?.matches(":popover-open") ?? false;
    this.render();
    if (wasOpen) {
      this.querySelector(".app-menu-popover")?.showPopover?.();
    }
  }

  render() {
    this.innerHTML = `
      <button
        class="app-menu-button"
        type="button"
        aria-label="Caffold menu"
        aria-haspopup="menu"
        popovertarget="${POPOVER_ID}"
      >
        <img class="app-menu-mark" src="/assets/icons/caffold-mark.svg" alt="" />
        <strong class="app-menu-name">Caffold</strong>
      </button>
      <div class="app-menu-popover" id="${POPOVER_ID}" popover role="menu">
        <button type="button" role="menuitem" data-action="open-settings">
          ${renderInlineIcon("Settings", "Settings", "app-menu-item-icon")}
          <span>Settings</span>
        </button>
      </div>
    `;
  }
}

customElements.define("caffold-app-menu", CaffoldAppMenu);
