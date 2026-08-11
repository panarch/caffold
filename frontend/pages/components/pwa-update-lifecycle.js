const ACTIVATE_PREPARED_BUILD_MESSAGE = "caffold:activate-prepared-build";
const CLAIM_PREPARED_BUILD_MESSAGE = "caffold:claim-prepared-build";
const GET_SERVICE_WORKER_BUILD_ID_MESSAGE = "caffold:get-build-id";
const PRUNE_SHELL_CACHES_MESSAGE = "caffold:prune-shell-caches";
const UPDATE_CONTROLLED_MESSAGE = "caffold:update-controlled";
const UPDATE_READY_MESSAGE = "caffold:update-ready";
const UPDATE_INTERVAL_MS = 30_000;
const SHELL_CACHE_PREFIX = "caffold-shell-";

export class PwaUpdateLifecycle {
  constructor({ currentBuildId, onReloadReady, onStatusChange }) {
    this.currentBuildId = currentBuildId;
    this.onReloadReady = onReloadReady;
    this.onStatusChange = onStatusChange;
    this.serverBuildId = null;
    this.connected = false;
    this.registration = null;
    this.registrationSettled = !("serviceWorker" in navigator);
    this.registrationRequest = null;
    this.updateIntervalId = null;
    this.updateRequest = null;
    this.settledCheckServerBuildId = null;
    this.readyServiceWorker = null;
    this.readyServiceWorkerBuildId = null;
    this.pendingReloadBuildId = null;
    this.claimRequestedBuildId = null;
    this.serviceWorkerBuildIds = new WeakMap();
    this.observedServiceWorkers = new Map();
    this.startedWithServiceWorkerController = Boolean(
      "serviceWorker" in navigator && navigator.serviceWorker.controller,
    );
    this.firstInstallationServiceWorker = null;
    this.suppressNextServiceWorkerAsFirstInstall = false;
    this.lastStatusKey = null;
    this.boundUpdateFound = () => this.handleUpdateFound();
    this.boundMessage = (event) => this.handleMessage(event);
    this.boundVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void this.checkForUpdate();
      }
    };
    this.boundOnline = () => void this.checkForUpdate();
  }

  start() {
    this.connect();
    if (this.registrationRequest) {
      return this.registrationRequest;
    }
    if (!("serviceWorker" in navigator)) {
      this.registrationSettled = true;
      this.emitStatus();
      this.registrationRequest = Promise.resolve(null);
      return this.registrationRequest;
    }

    const request = navigator.serviceWorker
      .register("/service-worker.js", { scope: "/" })
      .then((registration) => {
        this.registration = registration;
        this.registrationSettled = true;
        if (!this.startedWithServiceWorkerController) {
          this.firstInstallationServiceWorker =
            registration.active ?? registration.waiting ?? registration.installing;
          this.suppressNextServiceWorkerAsFirstInstall =
            !this.firstInstallationServiceWorker;
        }
        void this.pruneShellCachesIfSafe();
        if (this.connected) {
          this.attachRegistration();
        }
        return registration;
      })
      .catch(() => {
        this.registrationSettled = true;
        this.settledCheckServerBuildId = this.serverBuildId;
        this.emitStatus();
        return null;
      });
    this.registrationRequest = request;
    return request;
  }

  connect() {
    this.connected = true;
    if (this.registration) {
      this.attachRegistration();
    } else {
      this.emitStatus();
    }
  }

  disconnect() {
    this.connected = false;
    this.registration?.removeEventListener(
      "updatefound",
      this.boundUpdateFound,
    );
    navigator.serviceWorker?.removeEventListener?.(
      "message",
      this.boundMessage,
    );
    for (const [worker, listener] of this.observedServiceWorkers) {
      worker.removeEventListener("statechange", listener);
    }
    this.observedServiceWorkers.clear();
    document.removeEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    window.removeEventListener("online", this.boundOnline);
    if (this.updateIntervalId !== null) {
      window.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
  }

  setServerBuildId(buildId) {
    this.serverBuildId =
      typeof buildId === "string" && buildId ? buildId : null;
    if (this.serverBuildId === this.currentBuildId) {
      this.settledCheckServerBuildId = this.serverBuildId;
    }
    this.emitStatus();
    this.ensureServerBuildChecked();
  }

  snapshot() {
    return {
      state: this.updateState(),
      preparedUpdate: {
        ready: Boolean(this.readyServiceWorkerBuildId),
        buildId: this.readyServiceWorkerBuildId,
      },
    };
  }

  checkForUpdate() {
    const registration = this.registration;
    if (!this.connected || !registration || this.updateRequest) {
      return this.updateRequest;
    }

    const checkedBuildId = this.serverBuildId;
    const request = Promise.resolve()
      .then(() => registration.update())
      .then(() => {
        this.syncServiceWorkerState();
        return registration;
      })
      .catch(() => null)
      .finally(() => {
        if (this.updateRequest === request) {
          this.updateRequest = null;
          if (this.serverBuildId === checkedBuildId) {
            this.settledCheckServerBuildId = checkedBuildId;
          }
          this.syncServiceWorkerState();
          this.ensureServerBuildChecked();
        }
      });
    this.updateRequest = request;
    this.emitStatus();
    return request;
  }

  activatePreparedUpdate() {
    if (
      ["installed", "activated"].includes(this.readyServiceWorker?.state) &&
      this.readyServiceWorkerBuildId !== this.currentBuildId
    ) {
      this.pendingReloadBuildId = this.readyServiceWorkerBuildId;
      this.claimRequestedBuildId = null;
      this.requestPreparedBuildControl();
    }
  }

  attachRegistration() {
    const registration = this.registration;
    if (!registration || !this.connected) {
      return;
    }
    registration.removeEventListener("updatefound", this.boundUpdateFound);
    registration.addEventListener("updatefound", this.boundUpdateFound);
    this.observeServiceWorker(registration.installing);
    this.observeServiceWorker(registration.waiting);
    this.observeServiceWorker(registration.active);
    navigator.serviceWorker.removeEventListener("message", this.boundMessage);
    navigator.serviceWorker.addEventListener("message", this.boundMessage);
    this.attachUpdateChecks();
    this.syncServiceWorkerState();
    void this.checkForUpdate();
  }

  attachUpdateChecks() {
    document.removeEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    document.addEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    window.removeEventListener("online", this.boundOnline);
    window.addEventListener("online", this.boundOnline);
    if (this.updateIntervalId === null) {
      this.updateIntervalId = window.setInterval(() => {
        void this.checkForUpdate();
      }, UPDATE_INTERVAL_MS);
    }
  }

  handleUpdateFound() {
    const worker = this.registration?.installing;
    if (worker && this.suppressNextServiceWorkerAsFirstInstall) {
      this.firstInstallationServiceWorker = worker;
      this.suppressNextServiceWorkerAsFirstInstall = false;
    }
    this.syncServiceWorkerState();
  }

  handleMessage(event) {
    if (!this.connected) {
      return;
    }
    const buildId = event.data?.buildId;
    if (
      event.data?.type === UPDATE_CONTROLLED_MESSAGE &&
      event.source === this.readyServiceWorker &&
      buildId === this.pendingReloadBuildId
    ) {
      this.pendingReloadBuildId = null;
      this.onReloadReady();
      return;
    }
    if (
      event.data?.type !== UPDATE_READY_MESSAGE ||
      !event.source ||
      typeof buildId !== "string" ||
      !buildId
    ) {
      return;
    }
    this.serviceWorkerBuildIds.set(event.source, buildId);
    this.observeServiceWorker(event.source);
    this.syncServiceWorkerState();
  }

  observeServiceWorker(worker) {
    if (
      !this.connected ||
      !worker ||
      this.observedServiceWorkers.has(worker)
    ) {
      return;
    }
    const listener = () => this.syncServiceWorkerState();
    this.observedServiceWorkers.set(worker, listener);
    worker.addEventListener("statechange", listener);
    this.considerPreparedServiceWorker(worker);
  }

  syncServiceWorkerState() {
    if (!this.connected) {
      return;
    }
    const registration = this.registration;
    if (!registration) {
      this.emitStatus();
      return;
    }
    this.observeServiceWorker(registration.installing);
    this.observeServiceWorker(registration.waiting);
    this.observeServiceWorker(registration.active);
    this.reconcilePreparedServiceWorker();
    for (const worker of [registration.waiting, registration.active]) {
      if (
        ["installed", "activated"].includes(worker?.state) &&
        !this.serviceWorkerBuildIds.has(worker)
      ) {
        worker.postMessage({ type: GET_SERVICE_WORKER_BUILD_ID_MESSAGE });
      }
    }
    this.considerPreparedServiceWorker(registration.waiting);
    this.considerPreparedServiceWorker(registration.active);
    this.requestPreparedBuildControl();
    this.emitStatus();
    this.ensureServerBuildChecked();
  }

  considerPreparedServiceWorker(worker) {
    const workerBuildId = this.serviceWorkerBuildIds.get(worker);
    const waiting =
      worker?.state === "installed" && worker === this.registration?.waiting;
    const active =
      worker?.state === "activated" && worker === this.registration?.active;
    if (
      (!waiting && !active) ||
      worker === this.firstInstallationServiceWorker ||
      !workerBuildId ||
      workerBuildId === this.currentBuildId
    ) {
      return;
    }
    this.readyServiceWorker = worker;
    this.readyServiceWorkerBuildId = workerBuildId;
  }

  reconcilePreparedServiceWorker() {
    const worker = this.readyServiceWorker;
    if (
      !worker ||
      (worker.state !== "redundant" &&
        [this.registration?.waiting, this.registration?.active].includes(
          worker,
        ))
    ) {
      return;
    }
    const buildId = this.readyServiceWorkerBuildId;
    this.readyServiceWorker = null;
    this.readyServiceWorkerBuildId = null;
    if (this.pendingReloadBuildId === buildId) {
      this.pendingReloadBuildId = null;
    }
    if (this.claimRequestedBuildId === buildId) {
      this.claimRequestedBuildId = null;
    }
  }

  requestPreparedBuildControl() {
    const worker = this.readyServiceWorker;
    const buildId = this.readyServiceWorkerBuildId;
    if (!worker || buildId !== this.pendingReloadBuildId) {
      return;
    }
    if (
      worker.state === "installed" &&
      worker === this.registration?.waiting
    ) {
      worker.postMessage({ type: ACTIVATE_PREPARED_BUILD_MESSAGE });
      return;
    }
    if (
      worker.state === "activated" &&
      worker === this.registration?.active &&
      this.claimRequestedBuildId !== buildId
    ) {
      this.claimRequestedBuildId = buildId;
      worker.postMessage({ type: CLAIM_PREPARED_BUILD_MESSAGE });
    }
  }

  async pruneShellCachesIfSafe() {
    const controller = navigator.serviceWorker.controller;
    if (
      !controller ||
      this.registration?.installing ||
      this.registration?.waiting ||
      this.registration?.active !== controller
    ) {
      return;
    }
    const currentCacheName = `${SHELL_CACHE_PREFIX}${this.currentBuildId}`;
    let cacheNames;
    try {
      cacheNames = (await caches.keys()).filter(
        (name) =>
          name.startsWith(SHELL_CACHE_PREFIX) && name !== currentCacheName,
      );
    } catch {
      return;
    }
    if (
      cacheNames.length === 0 ||
      this.registration?.installing ||
      this.registration?.waiting ||
      this.registration?.active !== controller ||
      navigator.serviceWorker.controller !== controller
    ) {
      return;
    }
    controller.postMessage({
      type: PRUNE_SHELL_CACHES_MESSAGE,
      cacheNames,
    });
  }

  ensureServerBuildChecked() {
    if (
      !this.serverBuildId ||
      this.serverBuildId === this.currentBuildId ||
      this.readyServiceWorkerBuildId === this.serverBuildId ||
      !this.registration ||
      this.updateRequest ||
      this.settledCheckServerBuildId === this.serverBuildId
    ) {
      return;
    }
    void this.checkForUpdate();
  }

  updateState() {
    if (!("serviceWorker" in navigator)) {
      return "settled";
    }
    if (!this.registrationSettled) {
      return "checking";
    }
    if (!this.registration) {
      return "settled";
    }
    if (this.readyServiceWorkerBuildId) {
      return "ready";
    }
    if (this.updateRequest || this.hasUnsettledReplacementWorker()) {
      return "checking";
    }
    return this.settledCheckServerBuildId === this.serverBuildId
      ? "settled"
      : "checking";
  }

  hasUnsettledReplacementWorker() {
    const installing = this.registration?.installing;
    if (installing && installing.state !== "redundant") {
      return true;
    }
    const waiting = this.registration?.waiting;
    if (waiting && !this.serviceWorkerBuildIds.has(waiting)) {
      return true;
    }
    const active = this.registration?.active;
    return Boolean(
      active &&
        active !== navigator.serviceWorker.controller &&
        active !== this.firstInstallationServiceWorker &&
        !this.serviceWorkerBuildIds.has(active),
    );
  }

  emitStatus() {
    if (!this.connected) {
      return;
    }
    const status = this.snapshot();
    const statusKey = [
      status.state,
      status.preparedUpdate.ready,
      status.preparedUpdate.buildId,
    ].join(":");
    if (statusKey === this.lastStatusKey) {
      return;
    }
    this.lastStatusKey = statusKey;
    this.onStatusChange(status);
  }
}
