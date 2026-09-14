import {
  VOICE_KEY_PROVIDERS,
  VoiceSettingsLifecycle,
  voiceReadinessKey,
} from "./lifecycle.js";
import "../components/detail-list.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  radioActionHintTarget,
} from "../../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";

const PROVIDER_CHOICES = Object.freeze([
  {
    id: "whisper",
    label: "Whisper",
    detail: "Transcribes on this Mac after a one-time model download.",
  },
  {
    id: "openai",
    label: "OpenAI",
    detail: "Sends each recording to OpenAI with the API key saved here.",
  },
  {
    id: "gemini",
    label: "Gemini",
    detail: "Sends each recording to Google Gemini with the API key saved here.",
  },
]);
const KEY_PROVIDER_NAMES = Object.freeze({ openai: "OpenAI", gemini: "Gemini" });
const ACTION_BUTTONS = Object.freeze([
  { id: "refresh", selector: 'button[data-action="refresh"]', label: "Retry loading voice settings" },
  { id: "download-model", selector: 'button[data-action="download-model"]', label: "Download the Whisper model" },
  { id: "cancel-download", selector: 'button[data-action="cancel-download"]', label: "Cancel the Whisper download" },
  { id: "remove-model", selector: 'button[data-action="remove-model"]', label: "Delete the Whisper model" },
  ...VOICE_KEY_PROVIDERS.flatMap((provider) => [
    {
      id: `save-key:${provider}`,
      selector: `form[data-key-provider="${provider}"] button[type="submit"]`,
      label: `Save the ${KEY_PROVIDER_NAMES[provider]} API key`,
    },
    {
      id: `remove-key:${provider}`,
      selector: `button[data-action="remove-key"][data-provider="${provider}"]`,
      label: `Remove the ${KEY_PROVIDER_NAMES[provider]} API key`,
    },
  ]),
]);

class CaffoldSettingsVoicePage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.active = false;
    this.snapshot = {
      settings: null,
      fresh: false,
      busy: false,
      retry: false,
      message: "",
    };
    this.announcedReadiness = "";
    this.lifecycle = new VoiceSettingsLifecycle({
      onChange: (snapshot) => {
        this.snapshot = snapshot;
        this.announceReadiness(snapshot.settings);
        this.patch();
      },
    });
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("change", (event) => this.handleChange(event));
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
      case "download-model":
        void this.lifecycle.startDownload();
        break;
      case "cancel-download":
      case "remove-model":
        void this.lifecycle.removeModel();
        break;
      case "remove-key":
        void this.lifecycle.removeKey(button.dataset.provider);
        break;
    }
  }

  async handleChange(event) {
    const choice = event.target.closest('input[type="radio"][name="voice-provider"]');
    if (!choice?.checked) return;
    if (!(await this.lifecycle.selectProvider(choice.value))) {
      this.patch();
    }
  }

  async handleSubmit(event) {
    const form = event.target.closest("form[data-key-provider]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input[name="key"]');
    if (await this.lifecycle.storeKey(form.dataset.keyProvider, input.value)) {
      input.value = "";
    }
  }

  /**
   * Composers stay mounted while Settings is open, so they are told when the
   * values that decide their readiness change and read their own status again.
   */
  announceReadiness(settings) {
    if (!settings) return;
    const readiness = voiceReadinessKey(settings);
    if (readiness === this.announcedReadiness) return;
    this.announcedReadiness = readiness;
    window.dispatchEvent(new CustomEvent("caffold:voice-settings-changed"));
  }

  actionHintScope({
    scopeId = "settings:voice",
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
      targets: [
        ...PROVIDER_CHOICES.flatMap((choice) => providerChoiceTarget(this, context, choice)),
        ...ACTION_BUTTONS.flatMap((definition) => actionButtonTarget(this, context, definition)),
      ],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:voice",
    label = "Voice Input settings",
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
              <p id="settings-voice-description">Choose how voice input from the Task composer becomes text.</p>
              <p id="settings-voice-provider-note">Whisper runs on this Mac. OpenAI and Gemini receive each recording from this Caffold server.</p>
            </div>
            <button type="button" data-action="refresh" hidden>Retry</button>
          </header>
          <p class="settings-voice-message" role="alert" hidden></p>
          <fieldset
            class="settings-voice-options"
            aria-describedby="settings-voice-description settings-voice-provider-note"
          >
            <legend class="sr-only">Speech-to-text provider</legend>
            ${PROVIDER_CHOICES.map((choice) => `
              <label>
                <input type="radio" name="voice-provider" value="${choice.id}">
                <span class="settings-voice-option-copy">
                  <strong>${choice.label}</strong>
                  <span>${choice.detail}</span>
                </span>
              </label>
            `).join("")}
          </fieldset>
          <section
            class="settings-voice-provider"
            data-provider="whisper"
            aria-labelledby="settings-voice-whisper-title"
          >
            <h2 id="settings-voice-whisper-title">Whisper</h2>
            <caffold-settings-detail-list></caffold-settings-detail-list>
            <p class="settings-voice-download-error" role="status" hidden></p>
            <div class="settings-voice-actions">
              <button type="button" data-action="download-model" hidden>Download</button>
              <button type="button" data-action="cancel-download" hidden>Cancel download</button>
              <button type="button" data-action="remove-model" hidden>Delete model</button>
            </div>
          </section>
          ${VOICE_KEY_PROVIDERS.map((provider) => `
            <section
              class="settings-voice-provider"
              data-provider="${provider}"
              aria-labelledby="settings-voice-${provider}-title"
            >
              <h2 id="settings-voice-${provider}-title">${KEY_PROVIDER_NAMES[provider]}</h2>
              <caffold-settings-detail-list></caffold-settings-detail-list>
              <form class="settings-voice-key" data-key-provider="${provider}">
                <label for="settings-voice-${provider}-key">API key</label>
                <div class="settings-voice-key-row">
                  <input
                    id="settings-voice-${provider}-key"
                    name="key"
                    type="password"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                  >
                  <button type="submit">Save key</button>
                  <button type="button" data-action="remove-key" data-provider="${provider}" hidden>Remove key</button>
                </div>
              </form>
            </section>
          `).join("")}
        </div>
      </div>
    `;
  }

  patch() {
    if (!this.initialized) return;
    const { settings, fresh, busy, retry, message } = this.snapshot;
    const locked = busy || !fresh || !settings;
    const messageElement = this.querySelector(".settings-voice-message");
    messageElement.textContent = message;
    messageElement.hidden = !message;
    this.querySelector('button[data-action="refresh"]').hidden = !retry;

    const providers = this.querySelector(".settings-voice-options");
    providers.setAttribute("aria-busy", String(busy));
    for (const choice of providers.querySelectorAll('input[name="voice-provider"]')) {
      choice.checked = settings?.selected === choice.value;
      choice.disabled = locked;
    }

    const whisper = settings?.whisper ?? null;
    const whisperSection = this.querySelector('[data-provider="whisper"]');
    whisperSection.querySelector("caffold-settings-detail-list").setRows([
      { key: "model", label: "Model", value: whisper?.model, kind: "code" },
      { key: "revision", label: "Revision", value: whisper?.revision.slice(0, 7), kind: "code" },
      { key: "status", label: "Status", value: whisperStatus(whisper) },
    ]);
    const downloadError = whisperSection.querySelector(".settings-voice-download-error");
    downloadError.textContent = whisper?.downloadError ?? "";
    downloadError.hidden = !whisper?.downloadError;
    patchAction(whisperSection, "download-model", Boolean(whisper && !whisper.installed && !whisper.downloading), locked);
    patchAction(whisperSection, "cancel-download", Boolean(whisper?.downloading), locked);
    patchAction(whisperSection, "remove-model", Boolean(whisper?.installed && !whisper.downloading), locked);

    for (const provider of VOICE_KEY_PROVIDERS) {
      const cloud = settings?.[provider] ?? null;
      const saved = Boolean(cloud?.keyConfigured);
      const section = this.querySelector(`[data-provider="${provider}"]`);
      section.querySelector("caffold-settings-detail-list").setRows([
        { key: "model", label: "Model", value: cloud?.model, kind: "code" },
        { key: "api-key", label: "API key", value: cloud && (saved ? "Saved" : "Not saved") },
      ]);
      section.querySelector(".settings-voice-key label").textContent =
        saved ? "Replace API key" : "API key";
      const input = section.querySelector('input[name="key"]');
      input.placeholder = saved ? "Enter a new key to replace the saved one" : "";
      input.disabled = locked;
      section.querySelector('button[type="submit"]').disabled = locked;
      patchAction(section, "remove-key", saved, locked);
    }
  }
}

function patchAction(section, action, visible, disabled) {
  const button = section.querySelector(`button[data-action="${action}"]`);
  button.hidden = !visible;
  button.disabled = disabled;
}

function whisperStatus(whisper) {
  if (!whisper) return undefined;
  const size = formatBytes(whisper.bytes);
  if (whisper.downloading) return `Downloading (${size})`;
  if (!whisper.installed) return `Not downloaded (${size})`;
  return whisper.loaded ? "Loaded in memory" : "Downloaded";
}

function formatBytes(bytes) {
  const gibibyte = 1024 ** 3;
  return bytes >= gibibyte
    ? `${(bytes / gibibyte).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function providerChoiceTarget(owner, context, choice) {
  const selector = `input[type="radio"][name="voice-provider"][value="${choice.id}"]`;
  const control = owner.querySelector(selector);
  if (!controlAvailable(control) || control.checked) {
    return [];
  }
  return [radioActionHintTarget({
    invalidationOwner: owner,
    id: `${context.scopeId}:provider:${choice.id}`,
    actionId: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
    label: `Use ${choice.label} for voice input`,
    control,
    anchor: control.closest?.("label") ?? control,
    clipRoots: context.clipRoots,
    isActionable: () =>
      ownerIsCurrent(owner, context) &&
      owner.querySelector(selector) === control &&
      controlAvailable(control) &&
      !control.checked,
  })];
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
      ownerIsCurrent(owner, context) &&
      owner.querySelector(selector) === control &&
      controlAvailable(control),
  })];
}

function ownerIsCurrent(owner, { isCurrent }) {
  return owner.isConnected && !owner.hidden && isCurrent();
}

function controlAvailable(control) {
  return Boolean(
    control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control),
  );
}

customElements.define("caffold-settings-voice-page", CaffoldSettingsVoicePage);
