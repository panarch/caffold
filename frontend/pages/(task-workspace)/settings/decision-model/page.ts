import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import "../components/detail-list.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  DECISION_MODEL_PROVIDERS,
  type DecisionModelProvider,
  type DecisionModelSettings,
  DecisionModelSettingsLifecycle,
  type DecisionModelSettingsSnapshot,
} from "./lifecycle.js";

import styles from "./page.css.js";

const PROVIDER_CHOICES: Readonly<
  Record<DecisionModelProvider, { label: string; detail: string }>
> = Object.freeze({
  jev: {
    label: "Jev",
    detail:
      "Sends each permission request to TypeSafe with the API key saved here.",
  },
  openai: {
    label: "OpenAI",
    detail:
      "Sends each permission request to OpenAI with the API key saved here.",
  },
});

const PROVIDER_DESCRIPTION =
  "settings-decision-model-description settings-decision-model-note";

@customElement("caffold-settings-decision-model-page")
export class CaffoldSettingsDecisionModelPage extends CaffoldElement {
  @state()
  private accessor snapshot: DecisionModelSettingsSnapshot = {
    settings: null,
    fresh: false,
    busy: false,
    retry: false,
    message: "",
  };

  static override styles = styles;

  private active = false;
  // A half-written rule is the person's, not the server's. While one is being
  // typed the saved value stops being written back over it.
  private editing = false;
  private announcedOffer = "";
  private readonly lifecycle = new DecisionModelSettingsLifecycle({
    onChange: (snapshot) => {
      this.snapshot = snapshot;
      this.announceOffer(snapshot.settings);
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly criteria = new DrawnRef<HTMLTextAreaElement>(this);
  private readonly choiceLabels = new DrawnRefs<HTMLLabelElement>(this);
  private readonly keyInputs = new DrawnRefs<HTMLInputElement>(this);

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
              <p id="settings-decision-model-description">
                The model chosen here answers the routine permission requests
                of a Task whose composer chooses Caffold decides, so only the
                rest reach you.
              </p>
              <p id="settings-decision-model-note">
                Under that mode each request is sent to the chosen model's
                provider with these rules. Under every other mode nothing
                leaves this host.
              </p>
            </div>
            <button
              ${this.hints.button({
                id: "refresh",
                label: "Retry loading Decision Model settings",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="refresh"
              ?hidden=${!retry}
              @click=${this.refresh}
            >Retry</button>
          </header>
          <p
            class="settings-decision-model-message"
            role="alert"
            ?hidden=${!message}
          >${message}</p>
          <fieldset
            class="settings-decision-model-options"
            aria-describedby=${PROVIDER_DESCRIPTION}
            aria-busy=${String(busy)}
          >
            <legend class="sr-only">Decision model</legend>
            ${DECISION_MODEL_PROVIDERS.map((provider) => {
              const choice = PROVIDER_CHOICES[provider];
              return html`
                <label ${drawn(this.choiceLabels.of(provider))}>
                  <input
                    ${this.hints.radio({
                      id: `provider:${provider}`,
                      label: `Use ${choice.label} for permission decisions`,
                      action: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
                      when: settings?.selected !== provider,
                      anchor: () => this.choiceLabels.get(provider),
                    })}
                    type="radio"
                    name="decision-model-provider"
                    value=${provider}
                    .checked=${live(settings?.selected === provider)}
                    ?disabled=${locked}
                    @change=${this.chooseProvider}
                  >
                  <span class="settings-decision-model-option-copy">
                    <strong>${choice.label}</strong>
                    <span>${choice.detail}</span>
                  </span>
                </label>
              `;
            })}
          </fieldset>
          ${DECISION_MODEL_PROVIDERS.map(
            (provider) => html`
              <section
                class="settings-decision-model-provider"
                data-provider=${provider}
                aria-labelledby=${`settings-decision-model-${provider}-title`}
              >
                <h2 id=${`settings-decision-model-${provider}-title`}>${
                  PROVIDER_CHOICES[provider].label
                }</h2>
                <caffold-settings-detail-list
                  .rows=${providerRows(provider, settings)}
                ></caffold-settings-detail-list>
                <form
                  class="settings-decision-model-key"
                  data-key-provider=${provider}
                  @submit=${this.saveKey}
                >
                  <label for=${`settings-decision-model-${provider}-key`}>${
                    settings?.[provider].keyConfigured
                      ? "Replace API key"
                      : "API key"
                  }</label>
                  <div class="settings-decision-model-key-row">
                    <input
                      ${drawn(this.keyInputs.of(provider))}
                      ${this.hints.textbox({
                        id: `key:${provider}`,
                        label: `Focus ${PROVIDER_CHOICES[provider].label} API key`,
                        action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
                      })}
                      id=${`settings-decision-model-${provider}-key`}
                      name="key"
                      type="password"
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                      placeholder=${
                        settings?.[provider].keyConfigured
                          ? "Enter a new key to replace the saved one"
                          : ""
                      }
                      ?disabled=${locked}
                    >
                    <button
                      ${this.hints.button({
                        id: `save-key:${provider}`,
                        label: `Save the ${PROVIDER_CHOICES[provider].label} API key`,
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="submit"
                      ?disabled=${locked}
                    >Save key</button>
                    <button
                      ${this.hints.button({
                        id: `remove-key:${provider}`,
                        label: `Remove the ${PROVIDER_CHOICES[provider].label} API key`,
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="button"
                      data-action="remove-key"
                      data-provider=${provider}
                      ?hidden=${!settings?.[provider].keyConfigured}
                      ?disabled=${locked}
                      @click=${this.removeKey}
                    >Remove key</button>
                  </div>
                </form>
              </section>
            `,
          )}
          <form
            class="settings-decision-model-criteria"
            data-decision-model-form="criteria"
            @submit=${this.saveCriteria}
          >
            <label for="settings-decision-model-criteria">Extra rules</label>
            <p id="settings-decision-model-criteria-note">
              Optional. The chosen model already judges to the standard of a
              coding agent's automatic permission mode. Write here only what you
              want to add to that, or take away from it.
            </p>
            <textarea
              ${drawn(this.criteria)}
              ${this.hints.textbox({
                id: "criteria",
                label: "Focus Extra rules",
                action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
              })}
              id="settings-decision-model-criteria"
              name="criteria"
              rows="8"
              spellcheck="false"
              aria-describedby="settings-decision-model-criteria-note"
              ?disabled=${locked}
              @input=${this.startEditing}
            ></textarea>
            <div class="settings-decision-model-actions">
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

  actionHintScope({
    scopeId = "settings:decision-model",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:decision-model",
    label = "Decision Model settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  /**
   * Composers stay mounted while Settings is open, and the mode they offer
   * names the chosen model and is withheld until it has a key. They are told
   * when either changes so they ask for their list again instead of going on
   * offering the mode as it was.
   */
  private announceOffer(settings: DecisionModelSettings | null) {
    if (!settings) return;
    const offer = `${settings.selected}:${settings[settings.selected].keyConfigured}`;
    if (offer === this.announcedOffer) return;
    this.announcedOffer = offer;
    window.dispatchEvent(
      new CustomEvent("caffold:decision-model-settings-changed"),
    );
  }

  private refresh() {
    void this.lifecycle.refresh();
  }

  private removeKey(event: Event) {
    const provider = (event.currentTarget as HTMLElement).dataset.provider;
    void this.lifecycle.removeKey(provider ?? "");
  }

  // A provider the server refused leaves its radio checked until the next
  // render puts the chosen one back.
  private async chooseProvider(event: Event) {
    const choice = event.currentTarget as HTMLInputElement;
    if (!choice.checked) return;
    if (!(await this.lifecycle.selectProvider(choice.value))) {
      this.requestUpdate();
    }
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
    const form = event.currentTarget as HTMLFormElement;
    const provider = form.dataset.keyProvider ?? "";
    const input = this.keyInputs.get(provider);
    if (!input) return;
    if (await this.lifecycle.storeKey(provider, input.value)) {
      input.value = "";
    }
  }
}

function providerRows(
  provider: DecisionModelProvider,
  settings: DecisionModelSettings | null,
) {
  const saved = settings?.[provider].keyConfigured;
  return [
    {
      key: "api-key",
      label: "API key",
      value: settings ? (saved ? "Saved" : "Not saved") : undefined,
    },
    {
      key: "check",
      label: "Last check",
      value: lastCheckSummary(provider, settings),
    },
  ] as const;
}

function lastCheckSummary(
  provider: DecisionModelProvider,
  settings: DecisionModelSettings | null,
) {
  if (!settings) return undefined;
  const { keyConfigured, lastCheck } = settings[provider];
  if (!keyConfigured) return "No key to check";
  if (!lastCheck) return "Not checked since Caffold started";
  return lastCheck.ok
    ? `Answered by ${PROVIDER_CHOICES[provider].label}`
    : (lastCheck.message ?? "The key did not work.");
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-decision-model-page": CaffoldSettingsDecisionModelPage;
  }
}
