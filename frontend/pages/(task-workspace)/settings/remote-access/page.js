import {
  TailscaleLifecycle,
  tailscaleQrCodeUrl,
} from "./tailscale.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";

const STATE_COPY = Object.freeze({
  notInstalled: {
    label: "Tailscale is not installed",
    detail: "Install Tailscale on this Mac to set up optional access from another device. Localhost remains fully available without it.",
  },
  disconnected: {
    label: "Tailscale is disconnected",
    detail: "Open Tailscale and connect this Mac to a tailnet before enabling Caffold Serve.",
  },
  serveOff: {
    label: "Ready to enable",
    detail: "Tailscale is connected. Enable Caffold’s private, tailnet-only Serve mapping when you want access from another device.",
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
    detail: "Caffold cannot use Tailscale Serve right now. Another target may already own the private HTTPS mapping.",
  },
  failed: {
    label: "Remote access setup failed",
    detail: "The latest Tailscale status check or Serve operation did not complete. Check Tailscale and retry.",
  },
});

class CaffoldSettingsRemoteAccessPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.active = false;
    this.snapshot = {
      status: null,
      statusFresh: false,
      busy: false,
      message: "",
      retryIntent: null,
    };
    this.copyState = "idle";
    this.renderedQrUrl = "";
    this.lifecycle = new TailscaleLifecycle({
      onChange: (snapshot) => {
        const previousUrl = this.snapshot.status?.tailnetUrl ?? "";
        this.snapshot = snapshot;
        if (snapshot.status?.tailnetUrl !== previousUrl) {
          this.copyState = "idle";
        }
        this.patch();
      },
    });
    this.addEventListener("click", (event) => this.handleClick(event));
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
      case "enable":
        void this.lifecycle.setEnabled(true);
        break;
      case "disable":
        void this.lifecycle.setEnabled(false);
        break;
      case "retry":
        void this.lifecycle.retry();
        break;
      case "copy":
        void this.copyLink();
        break;
    }
  }

  async copyLink() {
    const url = this.snapshot.status?.tailnetUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
    this.patchCopyState();
  }

  actionHintScope({
    scopeId = "settings:remote-access",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const definitions = [
      { id: "refresh", selector: 'button[data-action="refresh"]' },
      { id: "enable", selector: 'button[data-action="enable"]' },
      { id: "disable", selector: 'button[data-action="disable"]' },
      { id: "retry", selector: 'button[data-action="retry"]' },
      { id: "copy-link", selector: 'button[data-action="copy"]' },
    ];
    const targets = definitions.flatMap(({ id, selector }) => {
      const control = this.querySelector(selector);
      if (
        !control ||
        control.disabled ||
        control.hidden ||
        !hasActionHintLayoutBox(control)
      ) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${scopeId}:${id}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          id,
        control,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          !control.hidden &&
          hasActionHintLayoutBox(control),
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:remote-access",
    label = "Remote access settings",
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
          this.querySelector(":scope > .settings-content-scroll") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
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
              <p>Use Tailscale Serve to reach this Caffold server privately from another device.</p>
              <p>Remote access is optional. Caffold continues to work locally on this Mac without Tailscale.</p>
            </div>
            <button type="button" data-action="refresh">Refresh</button>
          </header>
          <section class="settings-remote-status">
            <div role="status" aria-live="polite" aria-atomic="true" aria-labelledby="settings-remote-state-label">
              <h2 id="settings-remote-state-label"></h2>
              <p data-status-detail></p>
              <p class="settings-remote-diagnostic" data-status-diagnostic></p>
            </div>
            <div class="settings-remote-actions">
              <button type="button" data-action="enable" hidden>Enable</button>
              <button type="button" data-action="disable" hidden>Disable</button>
              <button type="button" data-action="retry" hidden>Retry</button>
            </div>
          </section>
          <p class="settings-remote-readonly" role="note" hidden>
            Serve settings are read-only from this device. To change them, open Caffold on the host Mac using its localhost address.
          </p>
          <p class="settings-remote-message" role="alert" hidden></p>
          <section class="settings-remote-ready" aria-labelledby="settings-remote-address-title" hidden>
            <div class="settings-remote-handoff">
              <div>
                <h2 id="settings-remote-address-title">Private access address</h2>
                <p>This Tailnet URL is private to devices and users permitted on the same tailnet.</p>
                <div class="settings-remote-address">
                  <code data-tailnet-address></code>
                  <div class="settings-remote-link-actions">
                    <button type="button" data-action="copy">Copy link</button>
                    <a data-action="open" target="_blank" rel="noopener noreferrer">Open link</a>
                  </div>
                </div>
                <p class="settings-remote-copy-message" role="status" aria-live="polite" hidden></p>
                <div class="settings-remote-prerequisite">
                  <h3>On the other device</h3>
                  <p>Install Tailscale, then sign in to an account permitted on the same tailnet before scanning or opening this address.</p>
                </div>
              </div>
              <figure>
                <img
                  class="settings-remote-qr"
                  data-qr-code
                  alt="QR code for the private access address"
                >
                <figcaption>Scan the exact private access address shown here.</figcaption>
              </figure>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  patch() {
    if (!this.initialized) return;
    const { status, statusFresh, busy, message, retryIntent } = this.snapshot;
    const state = status?.state ?? null;
    const copy = status
      ? STATE_COPY[state] ?? STATE_COPY.failed
      : message
        ? {
          label: "Remote access status is unavailable",
          detail: "Caffold could not read the current Tailscale status. Retry when the host is reachable.",
        }
        : {
          label: "Checking remote access",
          detail: "Reading Tailscale status from the Caffold server.",
        };
    const statusSection = this.querySelector(".settings-remote-status");
    statusSection.dataset.state = status?.state ?? (message ? "requestFailed" : "checking");
    statusSection.setAttribute("aria-busy", String(busy));
    this.querySelector("#settings-remote-state-label").textContent = copy.label;
    this.querySelector("[data-status-detail]").textContent = copy.detail;

    const diagnostic = this.querySelector("[data-status-diagnostic]");
    diagnostic.textContent = status?.diagnosticMessage ?? "";
    diagnostic.hidden = !status?.diagnosticMessage;

    const canManage = statusFresh === true && status?.canManage === true;
    this.patchAction("enable", canManage && state === "serveOff", busy);
    this.patchAction("disable", canManage && state === "ready", busy);
    this.patchAction(
      "retry",
      Boolean(retryIntent) || state === "failed" || state === "unavailable",
      busy,
    );
    this.querySelector('[data-action="refresh"]').disabled = busy;

    const readonly = this.querySelector(".settings-remote-readonly");
    readonly.hidden = statusFresh !== true || status?.canManage !== false;
    const messageElement = this.querySelector(".settings-remote-message");
    messageElement.textContent = message;
    messageElement.hidden = !message;

    const ready = state === "ready" && Boolean(status?.tailnetUrl);
    const readySection = this.querySelector(".settings-remote-ready");
    readySection.hidden = !ready;
    if (ready) {
      const url = status.tailnetUrl;
      this.querySelector("[data-tailnet-address]").textContent = url;
      this.querySelector('[data-action="open"]').href = url;
      if (this.renderedQrUrl !== url) {
        this.renderedQrUrl = url;
        const qr = this.querySelector("[data-qr-code]");
        qr.src = tailscaleQrCodeUrl(url);
        qr.dataset.tailnetUrl = url;
      }
    } else if (this.renderedQrUrl) {
      this.renderedQrUrl = "";
      const qr = this.querySelector("[data-qr-code]");
      qr.removeAttribute("src");
      delete qr.dataset.tailnetUrl;
    }
    this.patchCopyState();
  }

  patchAction(action, visible, disabled) {
    const button = this.querySelector(`[data-action="${action}"]`);
    button.hidden = !visible;
    button.disabled = disabled;
  }

  patchCopyState() {
    const button = this.querySelector('[data-action="copy"]');
    const message = this.querySelector(".settings-remote-copy-message");
    button.textContent = this.copyState === "copied" ? "Copied" : "Copy link";
    message.textContent = this.copyState === "failed"
      ? "The link could not be copied. Select the address and copy it manually."
      : this.copyState === "copied" ? "Private access address copied." : "";
    message.hidden = this.copyState === "idle";
  }
}

customElements.define(
  "caffold-settings-remote-access-page",
  CaffoldSettingsRemoteAccessPage,
);
