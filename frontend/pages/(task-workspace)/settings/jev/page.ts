import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  textboxActionHintTarget,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "../components/detail-list.ts";
import {
  type JevSettings,
  JevSettingsLifecycle,
  type JevSettingsSnapshot,
} from "./lifecycle.ts";

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
const TEXTBOXES = Object.freeze([
  { id: "criteria", selector: 'textarea[name="criteria"]' },
  { id: "key", selector: 'input[name="key"]' },
]);

interface ScopeContext {
  scopeId: string;
  clipRoots: Element[];
  isCurrent: () => boolean;
}

export class CaffoldSettingsJevPage extends LitElement {
  static properties = {
    snapshot: { state: true },
  };

  declare private snapshot: JevSettingsSnapshot;
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

  constructor() {
    super();
    this.snapshot = {
      settings: null,
      fresh: false,
      busy: false,
      retry: false,
      message: "",
    };
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
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

  render() {
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
      <div class="settings-content-scroll">
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
                id="settings-jev-key"
                name="key"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder=${placeholder}
                ?disabled=${locked}
              >
              <button type="submit" ?disabled=${locked}>Save key</button>
              <button
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

  updated() {
    const settings = this.snapshot.settings;
    const textarea = this.querySelector<HTMLTextAreaElement>(
      'textarea[name="criteria"]',
    );
    if (!this.editing && settings && textarea) {
      textarea.value = settings.criteria;
    }
  }

  actionHintScope({
    scopeId = "settings:jev",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
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
      targets: [
        ...ACTION_BUTTONS.flatMap((definition) =>
          actionButtonTarget(this, context, definition),
        ),
        ...TEXTBOXES.flatMap((definition) =>
          textboxTarget(this, context, definition),
        ),
      ],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:jev",
    label = "Jev Permissions settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
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
            this.querySelector(":scope > .settings-content-scroll") ===
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
    const form = event.currentTarget as HTMLFormElement;
    const textarea = form.querySelector<HTMLTextAreaElement>(
      'textarea[name="criteria"]',
    );
    if (!textarea) return;
    if (await this.lifecycle.saveCriteria(textarea.value)) {
      this.editing = false;
      this.requestUpdate();
    }
  }

  private async saveKey(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="key"]');
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

function actionButtonTarget(
  owner: HTMLElement,
  context: ScopeContext,
  { id, selector, label }: { id: string; selector: string; label: string },
) {
  const control = owner.querySelector<HTMLButtonElement>(selector);
  if (!control || !controlAvailable(control)) {
    return [];
  }
  return [
    buttonActionHintTarget({
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
    }),
  ];
}

function textboxTarget(
  owner: HTMLElement,
  context: ScopeContext,
  { id, selector }: { id: string; selector: string },
) {
  const control = owner.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!control || !controlAvailable(control)) {
    return [];
  }
  return [
    textboxActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:${id}`,
      actionId: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
      label: `Focus ${control.labels?.[0]?.textContent}`,
      control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        owner.isConnected &&
        !owner.hidden &&
        context.isCurrent() &&
        owner.querySelector(selector) === control &&
        controlAvailable(control),
    }),
  ];
}

function controlAvailable(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement,
) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
}

customElements.define("caffold-settings-jev-page", CaffoldSettingsJevPage);
