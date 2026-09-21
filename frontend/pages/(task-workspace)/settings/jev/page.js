import { JevSettingsLifecycle } from "./lifecycle.js";
import "../components/detail-list.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";

const ACTION_BUTTONS = Object.freeze([
  {
    id: "refresh",
    selector: 'button[data-action="refresh"]',
    label: "Retry loading Jev settings",
  },
  {
    id: "save-criteria",
    selector: 'form[data-jev-form="criteria"] button[type="submit"]',
    label: "Save the extra rules",
  },
  {
    id: "save-key",
    selector: 'form[data-jev-form="key"] button[type="submit"]',
    label: "Save the Jev API key",
  },
  {
    id: "remove-key",
    selector: 'button[data-action="remove-key"]',
    label: "Remove the Jev API key",
  },
]);

class CaffoldSettingsJevPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.active = false;
    this.editing = false;
    this.announcedAvailability = null;
    this.snapshot = {
      settings: null,
      fresh: false,
      busy: false,
      retry: false,
      message: "",
    };
    this.lifecycle = new JevSettingsLifecycle({
      onChange: (snapshot) => {
        this.snapshot = snapshot;
        this.announceAvailability(snapshot.settings);
        this.patch();
      },
    });
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("input", (event) => this.handleInput(event));
    this.addEventListener("submit", (event) => this.handleSubmit(event));
    this.mount();
    this.patch();
  }

  disconnectedCallback() {
    this.deactivate();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.lifecycle.activate();
  }

  deactivate() {
    this.active = false;
    this.lifecycle?.deactivate();
  }

  handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.action) {
      case "refresh":
        void this.lifecycle.refresh();
        break;
      case "remove-key":
        void this.lifecycle.removeKey();
        break;
    }
  }

  /**
   * A half-written rule is the person's, not the server's. While one is being
   * typed the saved value stops being written back over it.
   */
  handleInput(event) {
    if (event.target.closest('textarea[name="criteria"]')) {
      this.editing = true;
    }
  }

  async handleSubmit(event) {
    const form = event.target.closest("form[data-jev-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.jevForm === "criteria") {
      const textarea = form.querySelector('textarea[name="criteria"]');
      if (await this.lifecycle.saveCriteria(textarea.value)) {
        this.editing = false;
        this.patch();
      }
      return;
    }
    const input = form.querySelector('input[name="key"]');
    if (await this.lifecycle.storeKey(input.value)) {
      input.value = "";
    }
  }

  /**
   * Composers stay mounted while Settings is open, and the mode they offer is
   * withheld until a key exists. They are told when that answer changes so they
   * ask for their list again instead of going on offering a mode that is now
   * usable, or one that no longer is.
   */
  announceAvailability(settings) {
    if (!settings) return;
    const available = settings.keyConfigured;
    if (available === this.announcedAvailability) return;
    this.announcedAvailability = available;
    window.dispatchEvent(new CustomEvent("caffold:jev-settings-changed"));
  }

  actionHintScope({
    scopeId = "settings:jev",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const context = {
      scopeId,
      isCurrent,
      clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
    };
    return {
      blocked: false,
      targets: ACTION_BUTTONS.flatMap((definition) =>
        actionButtonTarget(this, context, definition)
      ),
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:jev",
    label = "Jev Permissions settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(":scope > .settings-content-scroll") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  mount() {
    this.innerHTML = `
      <div class="settings-content-scroll">
        <div class="settings-content-section">
          <header>
            <div>
              <p id="settings-jev-description">
                Jev holds back only the permission requests an automatic mode would stop
                for, so the rest never reaches you. A Task uses it when its composer
                chooses Ask Jev first.
              </p>
              <p id="settings-jev-note">
                Under that mode each request is sent to TypeSafe with these rules. Under
                every other mode nothing leaves this Mac.
              </p>
            </div>
            <button type="button" data-action="refresh" hidden>Retry</button>
          </header>
          <p class="settings-jev-message" role="alert" hidden></p>
          <caffold-settings-detail-list></caffold-settings-detail-list>
          <form class="settings-jev-criteria" data-jev-form="criteria">
            <label for="settings-jev-criteria">Extra rules</label>
            <p id="settings-jev-criteria-note">
              Optional. Jev already judges to the standard of a coding agent's automatic
              permission mode. Write here only what you want to add to that, or take away
              from it.
            </p>
            <textarea
              id="settings-jev-criteria"
              name="criteria"
              rows="8"
              spellcheck="false"
              aria-describedby="settings-jev-criteria-note"
            ></textarea>
            <div class="settings-jev-actions">
              <button type="submit">Save extra rules</button>
            </div>
          </form>
          <form class="settings-jev-key" data-jev-form="key">
            <label for="settings-jev-key">API key</label>
            <div class="settings-jev-key-row">
              <input
                id="settings-jev-key"
                name="key"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              >
              <button type="submit">Save key</button>
              <button type="button" data-action="remove-key" hidden>Remove key</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  patch() {
    if (!this.initialized) return;
    const { settings, fresh, busy, retry, message } = this.snapshot;
    const locked = busy || !fresh || !settings;
    const messageElement = this.querySelector(".settings-jev-message");
    messageElement.textContent = message;
    messageElement.hidden = !message;
    this.querySelector('button[data-action="refresh"]').hidden = !retry;

    const saved = Boolean(settings?.keyConfigured);
    this.querySelector("caffold-settings-detail-list").setRows([
      { key: "model", label: "Model", value: settings?.model, kind: "code" },
      { key: "api-key", label: "API key", value: settings && (saved ? "Saved" : "Not saved") },
      { key: "check", label: "Last check", value: lastCheckSummary(settings) },
    ]);

    const textarea = this.querySelector('textarea[name="criteria"]');
    if (!this.editing && settings) {
      textarea.value = settings.criteria;
    }
    textarea.disabled = locked;
    this.querySelector('form[data-jev-form="criteria"] button[type="submit"]').disabled = locked;

    this.querySelector(".settings-jev-key label").textContent =
      saved ? "Replace API key" : "API key";
    const input = this.querySelector('input[name="key"]');
    input.placeholder = saved ? "Enter a new key to replace the saved one" : "";
    input.disabled = locked;
    this.querySelector('form[data-jev-form="key"] button[type="submit"]').disabled = locked;
    const remove = this.querySelector('button[data-action="remove-key"]');
    remove.hidden = !saved;
    remove.disabled = locked;
  }
}

function lastCheckSummary(settings) {
  if (!settings) return undefined;
  if (!settings.keyConfigured) return "No key to check";
  const check = settings.lastCheck;
  if (!check) return "Not checked since Caffold started";
  return check.ok
    ? `Answered by ${check.model ?? settings.model}`
    : check.message ?? "The key did not work.";
}

function actionButtonTarget(owner, context, { id, selector, label }) {
  const control = owner.querySelector(selector);
  if (!controlAvailable(control)) {
    return [];
  }
  return [buttonActionHintTarget({
    invalidationOwner: owner,
    id: `${context.scopeId}:${id}`,
    actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
    label,
    control,
    clipRoots: context.clipRoots,
    isActionable: () =>
      owner.isConnected &&
      !owner.hidden &&
      context.isCurrent() &&
      owner.querySelector(selector) === control &&
      controlAvailable(control),
  })];
}

function controlAvailable(control) {
  return Boolean(
    control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control),
  );
}

customElements.define("caffold-settings-jev-page", CaffoldSettingsJevPage);
