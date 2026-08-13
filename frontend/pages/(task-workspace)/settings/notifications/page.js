import {
  getPushConfig,
  getPushInstallations,
  removePushInstallation,
  upsertPushInstallation,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import {
  applicationServerKey,
  getOrCreatePushClientId,
  installationLabel,
  notificationState,
  pushSupport,
  shortPushClientId,
  subscriptionPayload,
} from "./lifecycle.js";

const STATE_COPY = Object.freeze({
  unsupported: {
    label: "Unsupported",
    detail: "This browser does not provide the required Notification, Service Worker, and Push APIs.",
  },
  "not-installed": {
    label: "Install Caffold first",
    detail: "On this device, Web Push is available only after Caffold is added to the Home Screen.",
  },
  denied: {
    label: "Blocked by browser",
    detail: "Notification permission is denied. Re-enable it in the browser or system settings.",
  },
  "granted-not-subscribed": {
    label: "Permission granted, not subscribed",
    detail: "This browser has permission but no active Caffold Push registration. Enable to create or repair one.",
  },
  syncing: {
    label: "Syncing",
    detail: "Reconciling this browser with Caffold’s stored subscription state.",
  },
  subscribed: {
    label: "Subscribed",
    detail: "This browser will receive notifications for terminal task turns.",
  },
  disabled: {
    label: "Disabled",
    detail: "Notifications are off for this browser installation.",
  },
});

class CaffoldSettingsNotificationsPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.active = false;
    this.operation = 0;
    this.clientId = safeClientId();
    this.browserSubscription = null;
    this.serverState = "unknown";
    this.installations = [];
    this.state = "disabled";
    this.message = "";
    this.addEventListener("click", (event) => this.handleClick(event));
    this.render();
  }

  activate() {
    this.active = true;
    void this.reconcile();
  }

  deactivate() {
    this.active = false;
    this.operation += 1;
  }

  async reconcile() {
    const operation = ++this.operation;
    const support = pushSupport(window);
    if (!this.clientId || !support.supported || support.requiresInstallation) {
      this.state = notificationState({
        ...support,
        permission: window.Notification?.permission ?? "default",
        hasSubscription: false,
        serverState: "unknown",
      });
      this.render();
      return;
    }
    this.state = "syncing";
    this.message = "";
    this.browserSubscription = null;
    this.render();
    try {
      const [registration, response] = await Promise.all([
        navigator.serviceWorker.ready,
        getPushInstallations(this.clientId),
      ]);
      if (!this.isCurrent(operation)) return;
      let subscription = await registration.pushManager.getSubscription();
      this.serverState = response.currentState;
      this.installations = response.installations ?? [];

      if (this.serverState === "revoked") {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      } else if (subscription) {
        const label = await installationLabel();
        const summary = await upsertPushInstallation(
          this.clientId,
          subscriptionPayload(subscription, label),
        );
        this.serverState = "subscribed";
        this.installations = upsertSummary(this.installations, summary);
      } else if (this.serverState === "subscribed") {
        await removePushInstallation(this.clientId);
        this.serverState = "revoked";
        this.installations = this.installations.filter(
          (item) => item.clientId !== this.clientId,
        );
        this.message = "The stale server registration was removed because this browser no longer has its subscription.";
      }

      if (!this.isCurrent(operation)) return;
      this.browserSubscription = subscription;
      this.syncState(support);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message = error?.message ?? "Notification state could not be loaded.";
      this.syncState(support);
    }
  }

  async handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) {
      return;
    }
    const action = button.dataset.action;
    if (action === "enable") {
      // This call intentionally happens before any await and only inside the
      // explicit Enable click handler.
      const permissionRequest = Notification.requestPermission();
      await this.enable(permissionRequest);
      return;
    }
    if (action === "disable") {
      await this.disableCurrent();
      return;
    }
    if (action === "remove-installation") {
      await this.removeInstallation(button.dataset.clientId);
      return;
    }
    if (action === "refresh") {
      await this.reconcile();
    }
  }

  async enable(permissionRequest) {
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
    this.render();
    try {
      const permission = await permissionRequest;
      if (permission !== "granted") {
        this.browserSubscription = null;
        this.serverState = "unknown";
        this.syncState(pushSupport(window));
        return;
      }
      const [registration, config] = await Promise.all([
        navigator.serviceWorker.ready,
        getPushConfig(),
      ]);
      if (!this.isCurrent(operation)) return;
      let subscription = await registration.pushManager.getSubscription();
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey),
      });
      this.browserSubscription = subscription;
      const label = await installationLabel();
      const summary = await upsertPushInstallation(
        this.clientId,
        subscriptionPayload(subscription, label),
      );
      if (!this.isCurrent(operation)) return;
      this.browserSubscription = subscription;
      this.serverState = "subscribed";
      this.installations = upsertSummary(this.installations, summary);
      this.message = "Notifications enabled for this browser.";
      this.syncState(pushSupport(window));
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message = error?.message ?? "Notifications could not be enabled.";
      this.syncState(pushSupport(window));
    }
  }

  async disableCurrent() {
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
    this.render();
    try {
      await removePushInstallation(this.clientId);
      this.serverState = "revoked";
      this.installations = this.installations.filter(
        (item) => item.clientId !== this.clientId,
      );
      let localCleanupFailed = false;
      try {
        await this.browserSubscription?.unsubscribe();
      } catch {
        localCleanupFailed = true;
      }
      if (!this.isCurrent(operation)) return;
      if (!localCleanupFailed) {
        this.browserSubscription = null;
      }
      this.message = localCleanupFailed
        ? "Notifications are disabled on the server. This browser will retry local cleanup when the setting is reopened."
        : "Notifications disabled for this browser.";
      this.syncState(pushSupport(window));
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message = error?.message ?? "Notifications could not be disabled.";
      this.syncState(pushSupport(window));
    }
  }

  async removeInstallation(clientId) {
    if (!clientId) return;
    if (clientId === this.clientId) {
      await this.disableCurrent();
      return;
    }
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
    this.render();
    try {
      await removePushInstallation(clientId);
      if (!this.isCurrent(operation)) return;
      this.installations = this.installations.filter(
        (item) => item.clientId !== clientId,
      );
      this.message = "Browser installation removed.";
      this.syncState(pushSupport(window));
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message = error?.message ?? "Browser installation could not be removed.";
      this.syncState(pushSupport(window));
    }
  }

  syncState(support) {
    this.state = notificationState({
      ...support,
      permission: Notification.permission,
      hasSubscription: Boolean(this.browserSubscription),
      serverState: this.serverState,
    });
    this.render();
  }

  isCurrent(operation) {
    return this.active && operation === this.operation;
  }

  render() {
    const copy = STATE_COPY[this.state] ?? STATE_COPY.disabled;
    const busy = this.state === "syncing";
    const canEnable = ["disabled", "granted-not-subscribed"].includes(this.state);
    const canDisable = this.state === "subscribed";
    const installationCount = this.installations.length;
    const installationCountLabel = `${installationCount} ${
      installationCount === 1 ? "browser" : "browsers"
    }`;
    this.innerHTML = `
      <div class="settings-content-scroll">
        <div class="settings-content-section">
          <header>
            <div>
              <p>Receive a system notification when a managed task turn completes, fails, or is interrupted.</p>
              <p class="settings-notification-privacy">Notifications include only the current task name and terminal status—never prompts, generated content, repository paths, or working directories.</p>
            </div>
            <button type="button" data-action="refresh" ${busy ? "disabled" : ""}>Refresh</button>
          </header>
          <section class="settings-notification-status" data-state="${escapeHtml(this.state)}" aria-labelledby="settings-notification-state-label">
            <div>
              <h3 id="settings-notification-state-label">${escapeHtml(copy.label)}</h3>
              <p>${escapeHtml(copy.detail)}</p>
            </div>
            <div class="settings-notification-actions">
              ${canEnable ? '<button type="button" data-action="enable">Enable</button>' : ""}
              ${canDisable ? '<button type="button" data-action="disable">Disable</button>' : ""}
            </div>
          </section>
          <p class="settings-notification-message" role="status" aria-live="polite" ${this.message ? "" : "hidden"}>${escapeHtml(this.message)}</p>
          <section class="settings-installations" aria-labelledby="settings-installations-title">
            <header>
              <div>
                <h3 id="settings-installations-title">Subscribed browsers</h3>
                <p>Each browser receives notifications independently. Short IDs distinguish similar devices.</p>
              </div>
              <span>${installationCountLabel}</span>
            </header>
            <div class="settings-installation-list">
              ${this.renderInstallations(busy)}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  renderInstallations(busy) {
    if (!this.installations.length) {
      return '<p class="settings-installation-empty">No browsers are currently subscribed.</p>';
    }
    return this.installations
      .map((installation) => {
        const current = installation.clientId === this.clientId;
        const updated = formatTimestamp(installation.updatedAtMs);
        return `
          <article>
            <div>
              <h4>${escapeHtml(installation.installationLabel)}</h4>
              <p>
                <code>${escapeHtml(shortPushClientId(installation.clientId))}</code>
                ${current ? '<strong> This browser</strong>' : ""}
                <span>Updated ${escapeHtml(updated)}</span>
              </p>
            </div>
            <button
              type="button"
              data-action="remove-installation"
              data-client-id="${escapeHtml(installation.clientId)}"
              ${busy ? "disabled" : ""}
            >Remove</button>
          </article>
        `;
      })
      .join("");
  }
}

function safeClientId() {
  try {
    return getOrCreatePushClientId();
  } catch {
    return "";
  }
}

function upsertSummary(installations, summary) {
  return [
    summary,
    ...installations.filter((item) => item.clientId !== summary.clientId),
  ];
}

function formatTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "recently";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

customElements.define(
  "caffold-settings-notifications-page",
  CaffoldSettingsNotificationsPage,
);
