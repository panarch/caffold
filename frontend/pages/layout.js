import { getHealth } from "../api.js";
import { BUILD_INFO } from "../build-info.js";
import {
  parentRoute,
  parseRoute,
  routeEquals,
  routeUrl,
} from "../navigation-routes.js";
import "./(task-workspace)/layout.js";

class CaffoldAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.currentRoute = null;
    this.initialPath = "";
    this.render();
    this.taskWorkspace = this.querySelector("caffold-task-workspace");
    this.taskWorkspace.ensureRendered();
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
    this.addEventListener("caffold:close-task-workspace", () => {
      const route = parseRoute(window.location.href) ?? this.currentRoute;
      const parent = parentRoute(route);
      if (parent) {
        this.navigateToRoute(parent);
      }
    });
    this.bootstrap();
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
      <footer class="app-build-alert" role="status" aria-live="polite" hidden>
        <span data-build-alert-message></span>
        <button type="button" data-action="reload-build">Reload</button>
      </footer>
    `;
    this.querySelector('[data-action="reload-build"]')?.addEventListener(
      "click",
      () => window.location.reload(),
    );
    this.querySelector('[data-action="retry-bootstrap"]')?.addEventListener(
      "click",
      () => void this.bootstrap(),
    );
  }

  installNavigationHandlers() {
    this.usesNavigationApi =
      "navigation" in window &&
      typeof window.navigation?.addEventListener === "function" &&
      typeof window.navigation?.navigate === "function";

    if (this.usesNavigationApi) {
      window.navigation.addEventListener("navigate", (event) => {
        if (!event.canIntercept || event.hashChange || event.downloadRequest) {
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
    const alert = this.querySelector(".app-build-alert");
    const message = alert?.querySelector("[data-build-alert-message]");
    this.taskWorkspace?.setBuildStatus(health);
    if (!alert || !message) {
      return;
    }
    const serverId = health?.buildId;
    const serverLabel = health?.buildLabel || serverId;
    const mismatch = Boolean(serverId && serverId !== BUILD_INFO.id);
    alert.hidden = !mismatch;
    message.textContent = mismatch
      ? `New Caffold build available (${serverLabel}).`
      : "";
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
    return true;
  }
}

customElements.define("caffold-app-shell", CaffoldAppShell);
