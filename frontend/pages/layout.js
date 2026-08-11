import { getHealth } from "../api.js";
import { BUILD_INFO } from "../build-info.js";
import {
  parentRoute,
  parseRoute,
  routeEquals,
  routeUrl,
} from "../navigation-routes.js";
import { CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT } from "./components/build-mismatch-alert.js";
import { PwaUpdateLifecycle } from "./components/pwa-update-lifecycle.js";
import {
  CAFFOLD_UPDATE_LATER_EVENT,
  CAFFOLD_UPDATE_RELOAD_EVENT,
} from "./components/update-dialog.js";
import "./(task-workspace)/layout.js";

class CaffoldAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      this.pwaUpdateLifecycle?.connect();
      return;
    }

    this.initialized = true;
    this.currentRoute = null;
    this.initialPath = "";
    this.aboutHealthRequest = null;
    this.buildHealth = null;
    this.presentedUpdateBuildIds = new Set();
    this.pwaUpdateStatus = {
      state: "checking",
      preparedUpdate: { ready: false, buildId: null },
    };
    this.render();
    this.taskWorkspace = this.querySelector("caffold-task-workspace");
    this.taskWorkspace.ensureRendered();
    this.pwaUpdateLifecycle = new PwaUpdateLifecycle({
      currentBuildId: BUILD_INFO.id,
      onReloadReady: () => window.location.reload(),
      onStatusChange: (status) => this.applyPwaUpdateStatus(status),
    });
    this.installNavigationHandlers();

    const initialRoute = parseRoute(window.location.href);
    if (initialRoute) {
      this.currentRoute = initialRoute;
      this.taskWorkspace.prepareRoute(initialRoute, {
        defaultCwdPath: this.initialPath,
      });
    }

    this.addEventListener("caffold:open-tasks", () => {
      this.navigateToRoute({ kind: "tasks" });
    });
    this.addEventListener("caffold:open-settings", (event) => {
      this.navigateToRoute({
        kind: "settings",
        section: event.detail?.section ?? "",
      });
    });
    this.addEventListener("caffold:open-about", () => {
      this.navigateToRoute({ kind: "settings", section: "about" });
    });
    this.addEventListener("caffold:request-tasks-route", (event) => {
      this.navigateToRoute(event.detail?.route, {
        replace: Boolean(event.detail?.replace),
      });
    });
    this.addEventListener("caffold:request-settings-route", (event) => {
      this.navigateToRoute(event.detail?.route);
    });
    this.addEventListener("caffold:request-workspace-route", (event) => {
      this.navigateToRoute(event.detail?.route);
    });
    this.addEventListener(CAFFOLD_UPDATE_RELOAD_EVENT, (event) => {
      event.stopPropagation();
      this.pwaUpdateLifecycle.activatePreparedUpdate();
    });
    this.addEventListener(CAFFOLD_UPDATE_LATER_EVENT, (event) => {
      event.stopPropagation();
    });
    this.addEventListener(CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT, (event) => {
      event.stopPropagation();
      window.location.reload();
    });
    this.addEventListener("caffold:close-task-workspace", () => {
      const route = parseRoute(window.location.href) ?? this.currentRoute;
      const parent = parentRoute(route);
      if (parent) {
        this.navigateToRoute(parent);
      }
    });
    void this.pwaUpdateLifecycle.start();
    this.bootstrap();
  }

  disconnectedCallback() {
    this.pwaUpdateLifecycle?.disconnect();
  }

  render() {
    this.innerHTML = `
      <main class="app-main" aria-label="Workspace">
        <caffold-task-workspace></caffold-task-workspace>
        <section class="app-bootstrap-error" role="alert" hidden>
          <h1>Caffold is unavailable</h1>
          <p data-bootstrap-error-message></p>
          <button type="button" data-action="retry-bootstrap">Retry</button>
        </section>
      </main>
      <caffold-update-dialog></caffold-update-dialog>
      <caffold-build-mismatch-alert hidden></caffold-build-mismatch-alert>
    `;
    this.querySelector('[data-action="retry-bootstrap"]')?.addEventListener(
      "click",
      () => void this.bootstrap(),
    );
  }

  refreshAboutStatus() {
    void this.pwaUpdateLifecycle.checkForUpdate();
    if (this.aboutHealthRequest) {
      return this.aboutHealthRequest;
    }

    const request = getHealth()
      .then((health) => {
        this.updateBuildStatus(health);
        return health;
      })
      .catch(() => {
        this.updateBuildStatus(null);
        return null;
      })
      .finally(() => {
        if (this.aboutHealthRequest === request) {
          this.aboutHealthRequest = null;
        }
      });
    this.aboutHealthRequest = request;
    return request;
  }

  installNavigationHandlers() {
    this.usesNavigationApi =
      "navigation" in window &&
      typeof window.navigation?.addEventListener === "function" &&
      typeof window.navigation?.navigate === "function";

    if (this.usesNavigationApi) {
      window.navigation.addEventListener("navigate", (event) => {
        if (
          !event.canIntercept ||
          event.navigationType === "reload" ||
          event.hashChange ||
          event.downloadRequest
        ) {
          return;
        }
        const destination = new URL(event.destination.url);
        if (destination.origin !== window.location.origin) {
          return;
        }
        const route = parseRoute(destination.href);
        if (!route) {
          return;
        }
        event.intercept({
          handler: async () => {
            if (!this.currentRoute || !routeEquals(this.currentRoute, route)) {
              await this.applyRoute(route);
            }
          },
        });
      });
      window.navigation.addEventListener("currententrychange", () => {
        const route = parseRoute(window.location.href);
        if (route && (!this.currentRoute || !routeEquals(this.currentRoute, route))) {
          void this.applyRoute(route);
        }
      });
      return;
    }

    window.addEventListener("popstate", () => {
      const route = parseRoute(window.location.href);
      if (route) {
        void this.applyRoute(route);
      }
    });
  }

  async bootstrap() {
    this.setBootstrapError(null);
    try {
      const health = await getHealth();
      this.initialPath = health.initialPath ?? "";
      this.updateBuildStatus(health);
      const route = parseRoute(window.location.href);
      if (route) {
        await this.applyRoute(route);
      } else {
        this.navigateToRoute({ kind: "tasks" }, { replace: true });
      }
    } catch (error) {
      this.updateBuildStatus(null);
      this.setBootstrapError(error);
    }
  }

  setBootstrapError(error) {
    const panel = this.querySelector(".app-bootstrap-error");
    const message = panel?.querySelector("[data-bootstrap-error-message]");
    if (!panel || !message) {
      return;
    }
    panel.hidden = !error;
    this.taskWorkspace.hidden = Boolean(error);
    message.textContent = error?.message ?? "";
  }

  updateBuildStatus(health) {
    this.buildHealth = health ?? null;
    this.taskWorkspace?.setBuildStatus(this.buildHealth);
    this.pwaUpdateLifecycle?.setServerBuildId(this.buildHealth?.buildId);
    this.renderBuildAlert();
  }

  applyPwaUpdateStatus(status) {
    this.pwaUpdateStatus = {
      state: ["checking", "ready", "settled"].includes(status?.state)
        ? status.state
        : "checking",
      preparedUpdate: {
        ready: Boolean(status?.preparedUpdate?.ready),
        buildId: status?.preparedUpdate?.buildId ?? null,
      },
    };
    const preparedUpdate = this.pwaUpdateStatus.preparedUpdate;
    this.taskWorkspace?.setUpdateStatus(this.pwaUpdateStatus);
    this.renderBuildAlert();
    const updateDialog = this.querySelector("caffold-update-dialog");
    if (!preparedUpdate.ready) {
      updateDialog?.close();
      return;
    }
    if (!this.presentedUpdateBuildIds.has(preparedUpdate.buildId)) {
      this.presentedUpdateBuildIds.add(preparedUpdate.buildId);
      updateDialog?.open();
    }
  }

  renderBuildAlert() {
    const alert = this.querySelector("caffold-build-mismatch-alert");
    if (!alert) {
      return;
    }
    const serverId = this.buildHealth?.buildId;
    const serverLabel = this.buildHealth?.buildLabel || serverId;
    const mismatch = Boolean(
      serverId &&
        serverId !== BUILD_INFO.id &&
        this.pwaUpdateStatus.state === "settled",
    );
    alert.setStatus(mismatch ? { serverLabel } : null);
  }

  navigateToRoute(route, options = {}) {
    if (!route) {
      return false;
    }
    if (this.currentRoute && routeEquals(this.currentRoute, route)) {
      void this.applyRoute(route, options);
      return true;
    }
    const url = routeUrl(route);
    if (this.usesNavigationApi) {
      this.currentRoute = route;
      window.navigation.navigate(url, {
        history: options.replace ? "replace" : "push",
      });
      void this.applyRoute(route, options);
      return true;
    }
    const state = { caffoldRoute: route };
    if (options.replace) {
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
    void this.applyRoute(route, options);
    return true;
  }

  async applyRoute(route) {
    this.currentRoute = route;
    const canonicalUrl = routeUrl(route);
    if (window.location.pathname + window.location.search !== canonicalUrl) {
      window.history.replaceState({ caffoldRoute: route }, "", canonicalUrl);
    }
    this.setBootstrapError(null);
    await this.taskWorkspace.openRoute(route, {
      defaultCwdPath: this.initialPath || ".",
    });
    if (route.kind === "settings" && route.section === "about") {
      void this.refreshAboutStatus();
    }
    return true;
  }
}

customElements.define("caffold-app-shell", CaffoldAppShell);
