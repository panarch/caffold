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

    const workspaceEvent = {
      "open-tasks": "caffold:open-tasks",
      "open-settings": "caffold:open-settings",
      "open-about": "caffold:open-about",
    }[button.dataset.action];
    if (!workspaceEvent) {
      return;
    }

    this.closePopover();
    this.dispatchEvent(
      new CustomEvent(workspaceEvent, {
        bubbles: true,
        composed: true,
      }),
    );
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
        <img class="app-menu-mark" src="/assets/icons/favicon-32.png" alt="" />
        <strong class="app-menu-name">Caffold</strong>
      </button>
      <div class="app-menu-popover" id="${POPOVER_ID}" popover role="menu">
        <button type="button" role="menuitem" data-action="open-tasks">
          ${renderInlineIcon("ListTodo", "", "app-menu-item-icon")}
          <span>Tasks</span>
        </button>
        <button type="button" role="menuitem" data-action="open-settings">
          ${renderInlineIcon("Settings", "", "app-menu-item-icon")}
          <span>Settings</span>
        </button>
        <button type="button" role="menuitem" data-action="open-about">
          ${renderInlineIcon("Info", "", "app-menu-item-icon")}
          <span>About Caffold</span>
        </button>
      </div>
    `;
  }
}

customElements.define("caffold-app-menu", CaffoldAppMenu);
