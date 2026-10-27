import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import {
  TailscaleLifecycle,
  type TailscaleSnapshot,
  type TailscaleState,
  tailscaleQrCodeUrl,
} from "./tailscale.js";

import styles from "./page.css.js";

const STATE_COPY: Readonly<
  Record<TailscaleState, { label: string; detail: string }>
> = Object.freeze({
  notInstalled: {
    label: "Tailscale is not installed",
    detail:
      "Install Tailscale on this Mac to set up optional access from another device. Localhost remains fully available without it.",
  },
  disconnected: {
    label: "Tailscale is disconnected",
    detail:
      "Open Tailscale and connect this Mac to a tailnet before enabling Caffold Serve.",
  },
  serveOff: {
    label: "Ready to enable",
    detail:
      "Tailscale is connected. Enable Caffold’s private, tailnet-only Serve mapping when you want access from another device.",
  },
  configuring: {
    label: "Configuring private access",
    detail: "Caffold is enabling its Tailscale Serve mapping.",
  },
  disabling: {
    label: "Turning private access off",
    detail: "Caffold is disabling its Tailscale Serve mapping.",
  },
  ready: {
    label: "Private access is ready",
    detail: "Caffold is available to permitted devices on this tailnet.",
  },
  unavailable: {
    label: "Remote access is unavailable",
    detail:
      "Caffold cannot use Tailscale Serve right now. Another target may already own the private HTTPS mapping.",
  },
  failed: {
    label: "Remote access setup failed",
    detail:
      "The latest Tailscale status check or Serve operation did not complete. Check Tailscale and retry.",
  },
});

@customElement("caffold-settings-remote-access-page")
export class CaffoldSettingsRemoteAccessPage extends CaffoldElement {
  @state()
  private accessor snapshot: TailscaleSnapshot = {
    status: null,
    statusFresh: false,
    busy: false,
    message: "",
    retryIntent: null,
  };
  @state()
  private accessor copyState: "idle" | "copied" | "failed" = "idle";

  static override styles = styles;

  private active = false;
  readonly lifecycle = new TailscaleLifecycle({
    onChange: (snapshot) => {
      const previousUrl = this.snapshot.status?.tailnetUrl ?? "";
      this.snapshot = snapshot;
      if (snapshot.status?.tailnetUrl !== previousUrl) {
        this.copyState = "idle";
      }
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);

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
    const { status, statusFresh, busy, message, retryIntent } = this.snapshot;
    const state = status?.state ?? null;
    const copy = status
      ? (STATE_COPY[status.state] ?? STATE_COPY.failed)
      : message
        ? {
            label: "Remote access status is unavailable",
            detail:
              "Caffold could not read the current Tailscale status. Retry when the host is reachable.",
          }
        : {
            label: "Checking remote access",
            detail: "Reading Tailscale status from the Caffold server.",
          };
    const canManage = statusFresh === true && status?.canManage === true;
    const retryShown =
      Boolean(retryIntent) || state === "failed" || state === "unavailable";
    const url = state === "ready" ? (status?.tailnetUrl ?? null) : null;
    const copyLabel = this.copyState === "copied" ? "Copied" : "Copy link";
    const copyMessage =
      this.copyState === "failed"
        ? "The link could not be copied. Select the address and copy it manually."
        : this.copyState === "copied"
          ? "Private access address copied."
          : "";
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
                Use Tailscale Serve to reach this Caffold server privately from
                another device.
              </p>
              <p>
                Remote access is optional. Caffold continues to work locally on
                this Mac without Tailscale.
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
              @click=${this.refresh}
            >Refresh</button>
          </header>
          <section
            class="settings-remote-status"
            data-state=${state ?? (message ? "requestFailed" : "checking")}
            aria-busy=${String(busy)}
          >
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-labelledby="settings-remote-state-label"
            >
              <h2 id="settings-remote-state-label">${copy.label}</h2>
              <p data-status-detail>${copy.detail}</p>
              <p
                class="settings-remote-diagnostic"
                data-status-diagnostic
                ?hidden=${!status?.diagnosticMessage}
              >${status?.diagnosticMessage ?? ""}</p>
            </div>
            <div class="settings-remote-actions">
              <button
                ${this.hints.button({
                  id: "enable",
                  label: "Enable",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="enable"
                ?hidden=${!(canManage && state === "serveOff")}
                ?disabled=${busy}
                @click=${this.enable}
              >Enable</button>
              <button
                ${this.hints.button({
                  id: "disable",
                  label: "Disable",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="disable"
                ?hidden=${!(canManage && state === "ready")}
                ?disabled=${busy}
                @click=${this.disable}
              >Disable</button>
              <button
                ${this.hints.button({
                  id: "retry",
                  label: "Retry",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="retry"
                ?hidden=${!retryShown}
                ?disabled=${busy}
                @click=${this.retry}
              >Retry</button>
            </div>
          </section>
          <p
            class="settings-remote-readonly"
            role="note"
            ?hidden=${statusFresh !== true || status?.canManage !== false}
          >
            Serve settings are read-only from this device. To change them, open
            Caffold on the host Mac using its localhost address.
          </p>
          <p
            class="settings-remote-message"
            role="alert"
            ?hidden=${!message}
          >${message}</p>
          <section
            class="settings-remote-ready"
            aria-labelledby="settings-remote-address-title"
            ?hidden=${!url}
          >
            <div class="settings-remote-handoff">
              <div>
                <h2 id="settings-remote-address-title">
                  Private access address
                </h2>
                <p>
                  This Tailnet URL is private to devices and users permitted on
                  the same tailnet.
                </p>
                <div class="settings-remote-address">
                  <code data-tailnet-address>${url ?? ""}</code>
                  <div class="settings-remote-link-actions">
                    <button
                      ${this.hints.button({
                        id: "copy-link",
                        label: copyLabel,
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="button"
                      data-action="copy"
                      @click=${this.copyLink}
                    >${copyLabel}</button>
                    <a
                      ${this.hints.link({
                        id: "open-link",
                        label: "Open private access address in a new tab",
                        action: ACTION_HINT_ACTION.LINK_OPEN,
                        when: Boolean(url),
                      })}
                      data-action="open"
                      href=${url ?? nothing}
                      target="_blank"
                      rel="noopener noreferrer"
                    >Open link</a>
                  </div>
                </div>
                <p
                  class="settings-remote-copy-message"
                  role="status"
                  aria-live="polite"
                  ?hidden=${this.copyState === "idle"}
                >${copyMessage}</p>
                <div class="settings-remote-prerequisite">
                  <h3>On the other device</h3>
                  <p>
                    Install Tailscale, then sign in to an account permitted on
                    the same tailnet before scanning or opening this address.
                  </p>
                </div>
              </div>
              <figure>
                <img
                  class="settings-remote-qr"
                  data-qr-code
                  src=${url ? tailscaleQrCodeUrl(url) : nothing}
                  data-tailnet-url=${url ?? nothing}
                  alt="QR code for the private access address"
                >
                <figcaption>
                  Scan the exact private access address shown here.
                </figcaption>
              </figure>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:remote-access",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:remote-access",
    label = "Remote access settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private refresh() {
    void this.lifecycle.refresh();
  }

  private enable() {
    void this.lifecycle.setEnabled(true);
  }

  private disable() {
    void this.lifecycle.setEnabled(false);
  }

  private retry() {
    void this.lifecycle.retry();
  }

  private async copyLink() {
    const url = this.snapshot.status?.tailnetUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-remote-access-page": CaffoldSettingsRemoteAccessPage;
  }
}
