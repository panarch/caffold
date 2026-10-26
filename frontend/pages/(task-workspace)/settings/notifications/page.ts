import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import {
  getPushConfig,
  getPushInstallations,
  type PushInstallation,
  removePushInstallation,
  upsertPushInstallation,
} from "#app/api.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import {
  applicationServerKey,
  getOrCreatePushClientId,
  installationLabel,
  type NotificationState,
  notificationState,
  pushSupport,
  shortPushClientId,
  subscriptionPayload,
} from "./lifecycle.ts";

const STATE_COPY: Readonly<
  Record<NotificationState, { label: string; detail: string }>
> = Object.freeze({
  unsupported: {
    label: "Unsupported",
    detail:
      "This browser does not provide the required Notification, Service Worker, and Push APIs.",
  },
  "not-installed": {
    label: "Install Caffold first",
    detail:
      "On this device, Web Push is available only after Caffold is added to the Home Screen.",
  },
  denied: {
    label: "Blocked by browser",
    detail:
      "Notification permission is denied. Re-enable it in the browser or system settings.",
  },
  "granted-not-subscribed": {
    label: "Permission granted, not subscribed",
    detail:
      "This browser has permission but no active Caffold Push registration. Enable to create or repair one.",
  },
  syncing: {
    label: "Syncing",
    detail:
      "Reconciling this browser with Caffold’s stored subscription state.",
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

export class CaffoldSettingsNotificationsPage extends LitElement {
  static properties = {
    installations: { state: true },
    state: { state: true },
    message: { state: true },
  };

  declare private installations: PushInstallation[];
  declare private state: NotificationState;
  declare private message: string;
  private active = false;
  private operation = 0;
  private readonly clientId = safeClientId();
  private browserSubscription: PushSubscription | null = null;
  private serverState = "unknown";
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.installations = [];
    this.state = "disabled";
    this.message = "";
  }

  createRenderRoot() {
    return this;
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
      return;
    }
    this.state = "syncing";
    this.message = "";
    this.browserSubscription = null;
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
        this.message =
          "The stale server registration was removed because this browser no longer has its subscription.";
      }

      if (!this.isCurrent(operation)) return;
      this.browserSubscription = subscription;
      this.syncState(support);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message =
        (error as Error | null)?.message ??
        "Notification state could not be loaded.";
      this.syncState(support);
    }
  }

  render() {
    const copy = STATE_COPY[this.state] ?? STATE_COPY.disabled;
    const busy = this.state === "syncing";
    const canEnable = ["disabled", "granted-not-subscribed"].includes(
      this.state,
    );
    const canDisable = this.state === "subscribed";
    const installationCount = this.installations.length;
    const installationCountLabel = `${installationCount} ${
      installationCount === 1 ? "browser" : "browsers"
    }`;
    const installations = installationCount
      ? repeat(
          this.installations,
          (installation) => installation.clientId,
          (installation) => this.installation(installation, busy),
        )
      : html`<p class="settings-installation-empty">
          No browsers are currently subscribed.
        </p>`;
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
              <p>
                Receive a system notification when a managed task turn
                completes, fails, or is interrupted, and when a task waits for
                you to answer an approval.
              </p>
              <p class="settings-notification-privacy">
                Notifications include only the current task name with its
                terminal status or that an approval is required—never what was
                asked, prompts, generated content, repository paths, or working
                directories.
              </p>
            </div>
            <button
              ${this.hints.button({
                id: "refresh",
                label: "Refresh",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="refresh"
              ?disabled=${busy}
              @click=${this.reconcile}
            >Refresh</button>
          </header>
          <section
            class="settings-notification-status"
            data-state=${this.state}
            aria-labelledby="settings-notification-state-label"
          >
            <div>
              <h3 id="settings-notification-state-label">${copy.label}</h3>
              <p>${copy.detail}</p>
            </div>
            <div class="settings-notification-actions">
              ${
                canEnable
                  ? html`<button
                      ${this.hints.button({
                        id: "enable",
                        label: "Enable",
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="button"
                      data-action="enable"
                      @click=${this.enable}
                    >Enable</button>`
                  : nothing
              }
              ${
                canDisable
                  ? html`<button
                      ${this.hints.button({
                        id: "disable",
                        label: "Disable",
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="button"
                      data-action="disable"
                      @click=${this.disableCurrent}
                    >Disable</button>`
                  : nothing
              }
            </div>
          </section>
          <p
            class="settings-notification-message"
            role="status"
            aria-live="polite"
            ?hidden=${!this.message}
          >${this.message}</p>
          <section
            class="settings-installations"
            aria-labelledby="settings-installations-title"
          >
            <header>
              <div>
                <h3 id="settings-installations-title">Subscribed browsers</h3>
                <p>
                  Each browser receives notifications independently. Short IDs
                  distinguish similar devices.
                </p>
              </div>
              <span>${installationCountLabel}</span>
            </header>
            <div class="settings-installation-list">${installations}</div>
          </section>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:notifications",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:notifications",
    label = "Notification settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private installation(installation: PushInstallation, busy: boolean) {
    const current = installation.clientId === this.clientId;
    const updated = formatTimestamp(installation.updatedAtMs);
    return html`
      <article>
        <div>
          <h4>${installation.installationLabel}</h4>
          <p>
            <code>${shortPushClientId(installation.clientId)}</code>
            ${current ? html`<strong> This browser</strong>` : nothing}
            <span>Updated ${updated}</span>
          </p>
        </div>
        <button
          ${this.hints.button({
            id: `remove-installation:${installation.clientId}`,
            label: `Remove ${installation.installationLabel}`,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          data-action="remove-installation"
          data-client-id=${installation.clientId}
          ?disabled=${busy}
          @click=${() => this.removeInstallation(installation.clientId)}
        >Remove</button>
      </article>
    `;
  }

  // The permission request happens before any await, inside the Enable click
  // itself.
  private enable() {
    const permissionRequest = Notification.requestPermission();
    return this.subscribe(permissionRequest);
  }

  private async subscribe(permissionRequest: Promise<NotificationPermission>) {
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
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
      this.message =
        (error as Error | null)?.message ??
        "Notifications could not be enabled.";
      this.syncState(pushSupport(window));
    }
  }

  private async disableCurrent() {
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
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
      this.message =
        (error as Error | null)?.message ??
        "Notifications could not be disabled.";
      this.syncState(pushSupport(window));
    }
  }

  private async removeInstallation(clientId: string) {
    if (!clientId) return;
    if (clientId === this.clientId) {
      await this.disableCurrent();
      return;
    }
    const operation = ++this.operation;
    this.state = "syncing";
    this.message = "";
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
      this.message =
        (error as Error | null)?.message ??
        "Browser installation could not be removed.";
      this.syncState(pushSupport(window));
    }
  }

  private syncState(support: ReturnType<typeof pushSupport>) {
    this.state = notificationState({
      ...support,
      permission: Notification.permission,
      hasSubscription: Boolean(this.browserSubscription),
      serverState: this.serverState,
    });
  }

  private isCurrent(operation: number) {
    return this.active && operation === this.operation;
  }
}

function safeClientId() {
  try {
    return getOrCreatePushClientId();
  } catch {
    return "";
  }
}

function upsertSummary(
  installations: PushInstallation[],
  summary: PushInstallation,
) {
  return [
    summary,
    ...installations.filter((item) => item.clientId !== summary.clientId),
  ];
}

function formatTimestamp(timestamp: number | undefined) {
  if (!Number.isFinite(timestamp)) {
    return "recently";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp ?? 0));
}

customElements.define(
  "caffold-settings-notifications-page",
  CaffoldSettingsNotificationsPage,
);
