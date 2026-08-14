import {
  PWA_UPDATE_HANDOFF_EFFECT,
  PWA_UPDATE_HANDOFF_EVENT,
  PWA_UPDATE_HANDOFF_NODE,
  PWA_UPDATE_TARGET_PHASE,
  createPwaUpdateHandoffState,
  transitionPwaUpdateHandoff,
} from "./machine.js";

const ACTIVATE_PREPARED_BUILD_MESSAGE = "caffold:activate-prepared-build";
const CLAIM_PREPARED_BUILD_MESSAGE = "caffold:claim-prepared-build";
const GET_SERVICE_WORKER_BUILD_ID_MESSAGE = "caffold:get-build-id";
const PRUNE_SHELL_CACHES_MESSAGE = "caffold:prune-shell-caches";
const UPDATE_CONTROLLED_MESSAGE = "caffold:update-controlled";
const UPDATE_READY_MESSAGE = "caffold:update-ready";
const UPDATE_INTERVAL_MS = 30_000;
const SHELL_CACHE_PREFIX = "caffold-shell-";

export class PwaUpdateRuntime {
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
    this.preparedGeneration = 0;
    this.serviceWorkerBuildIds = new WeakMap();
    this.serviceWorkersByBuildId = new Map();
    this.observedServiceWorkers = new Map();
    this.handoffState = createPwaUpdateHandoffState();
    this.startedWithServiceWorkerController = Boolean(
      "serviceWorker" in navigator && navigator.serviceWorker.controller,
    );
    this.firstInstallationServiceWorker = null;
    this.suppressNextServiceWorkerAsFirstInstall = false;
    this.lastStatusKey = null;
    this.boundUpdateFound = () => this.handleUpdateFound();
    this.boundMessage = (event) => this.handleMessage(event);
    this.boundControllerChange = () => {
      this.syncServiceWorkerState({ resumeHandoff: false });
      void this.pruneShellCachesIfSafe();
    };
    this.boundResume = () => {
      if (document.visibilityState === "visible") {
        this.syncServiceWorkerState({ resumeHandoff: true });
        void this.checkForUpdate();
      }
    };
    this.boundPageShow = (event) => {
      if (event.persisted) {
        this.boundResume();
      }
    };
    this.boundOnline = () => {
      this.syncServiceWorkerState({ resumeHandoff: true });
      void this.checkForUpdate();
    };
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
        if (this.connected) {
          this.attachRegistration();
        }
        void this.pruneShellCachesIfSafe();
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
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.dispatchHandoff({
      type: PWA_UPDATE_HANDOFF_EVENT.CONNECTED,
      phase: this.targetPhase(),
    });
    if (this.registration) {
      this.attachRegistration();
    } else {
      this.emitStatus();
    }
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.registration?.removeEventListener(
      "updatefound",
      this.boundUpdateFound,
    );
    navigator.serviceWorker?.removeEventListener?.(
      "message",
      this.boundMessage,
    );
    navigator.serviceWorker?.removeEventListener?.(
      "controllerchange",
      this.boundControllerChange,
    );
    for (const [worker, listener] of this.observedServiceWorkers) {
      worker.removeEventListener("statechange", listener);
    }
    this.observedServiceWorkers.clear();
    document.removeEventListener("visibilitychange", this.boundResume);
    document.removeEventListener("resume", this.boundResume);
    window.removeEventListener("pageshow", this.boundPageShow);
    window.removeEventListener("online", this.boundOnline);
    if (this.updateIntervalId !== null) {
      window.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    this.dispatchHandoff({ type: PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED });
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
        this.syncServiceWorkerState({ resumeHandoff: false });
        return registration;
      })
      .catch(() => null)
      .finally(() => {
        if (this.updateRequest === request) {
          this.updateRequest = null;
          if (this.serverBuildId === checkedBuildId) {
            this.settledCheckServerBuildId = checkedBuildId;
          }
          this.syncServiceWorkerState({ resumeHandoff: true });
          this.ensureServerBuildChecked();
        }
      });
    this.updateRequest = request;
    this.emitStatus();
    return request;
  }

  activatePreparedUpdate() {
    const worker = this.readyServiceWorker;
    const buildId = this.readyServiceWorkerBuildId;
    if (!worker || !buildId || buildId === this.currentBuildId) {
      return;
    }
    this.dispatchHandoff({
      type: PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED,
      buildId,
      generation: this.preparedGeneration,
      phase: this.phaseForWorker(worker, buildId),
    });
    this.emitStatus();
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
    this.observeServiceWorker(navigator.serviceWorker.controller);
    navigator.serviceWorker.removeEventListener("message", this.boundMessage);
    navigator.serviceWorker.addEventListener("message", this.boundMessage);
    navigator.serviceWorker.removeEventListener(
      "controllerchange",
      this.boundControllerChange,
    );
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      this.boundControllerChange,
    );
    this.attachUpdateChecks();
    this.syncServiceWorkerState({ resumeHandoff: true });
    void this.checkForUpdate();
  }

  attachUpdateChecks() {
    document.removeEventListener("visibilitychange", this.boundResume);
    document.addEventListener("visibilitychange", this.boundResume);
    document.removeEventListener("resume", this.boundResume);
    document.addEventListener("resume", this.boundResume);
    window.removeEventListener("pageshow", this.boundPageShow);
    window.addEventListener("pageshow", this.boundPageShow);
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
    this.syncServiceWorkerState({ resumeHandoff: false });
  }

  handleMessage(event) {
    if (!this.connected) {
      return;
    }
    const buildId = event.data?.buildId;
    if (
      event.data?.type === UPDATE_CONTROLLED_MESSAGE &&
      buildId === this.handoffState.targetBuildId
    ) {
      // The custom response is only a hint. The current controller still decides
      // whether the intended build owns this document.
      this.syncServiceWorkerState({ resumeHandoff: true });
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
    this.recordServiceWorkerBuild(event.source, buildId);
    this.observeServiceWorker(event.source);
    this.syncServiceWorkerState({ resumeHandoff: false });
  }

  observeServiceWorker(worker) {
    if (
      !this.connected ||
      !worker ||
      this.observedServiceWorkers.has(worker)
    ) {
      return;
    }
    const listener = () =>
      this.syncServiceWorkerState({ resumeHandoff: false });
    this.observedServiceWorkers.set(worker, listener);
    worker.addEventListener("statechange", listener);
  }

  recordServiceWorkerBuild(worker, buildId) {
    this.serviceWorkerBuildIds.set(worker, buildId);
    this.serviceWorkersByBuildId.set(buildId, worker);
  }

  syncServiceWorkerState({ resumeHandoff = false } = {}) {
    if (!this.connected) {
      return;
    }
    const registration = this.registration;
    if (!registration) {
      this.emitStatus();
      return;
    }
    for (const worker of [
      registration.installing,
      registration.waiting,
      registration.active,
      navigator.serviceWorker.controller,
    ]) {
      this.observeServiceWorker(worker);
    }
    this.reconcilePreparedServiceWorker();
    for (const worker of [
      registration.waiting,
      registration.active,
      navigator.serviceWorker.controller,
    ]) {
      if (
        ["installed", "activated"].includes(worker?.state) &&
        !this.serviceWorkerBuildIds.has(worker)
      ) {
        worker.postMessage({ type: GET_SERVICE_WORKER_BUILD_ID_MESSAGE });
      }
    }
    this.syncHandoffState({ resumeHandoff });
    this.emitStatus();
    this.ensureServerBuildChecked();
  }

  reconcilePreparedServiceWorker() {
    const waitingCandidate = this.preparedCandidate(
      this.registration?.waiting,
      "waiting",
    );
    if (waitingCandidate) {
      this.setPreparedServiceWorker(
        waitingCandidate.worker,
        waitingCandidate.buildId,
      );
      return;
    }

    const activeCandidate = this.preparedCandidate(
      this.registration?.active,
      "active",
    );
    const targetWorker = this.workerForBuild(this.handoffState.targetBuildId);
    if (
      activeCandidate &&
      this.handoffState.targetBuildId &&
      activeCandidate.buildId !== this.handoffState.targetBuildId &&
      targetWorker?.state !== "redundant"
    ) {
      // A newer waiting target can be temporarily absent from registration
      // slots while an older active worker is still observable.
      return;
    }
    if (activeCandidate) {
      this.setPreparedServiceWorker(
        activeCandidate.worker,
        activeCandidate.buildId,
      );
      return;
    }

    const worker = this.readyServiceWorker;
    const buildId = this.readyServiceWorkerBuildId;
    if (!worker || !buildId) {
      return;
    }
    const handoffOwnsWorker = this.handoffState.targetBuildId === buildId;
    if (worker.state !== "redundant" && handoffOwnsWorker) {
      return;
    }
    if (
      worker.state !== "redundant" &&
      [this.registration?.waiting, this.registration?.active].includes(worker)
    ) {
      return;
    }

    this.readyServiceWorker = null;
    this.readyServiceWorkerBuildId = null;
    if (
      handoffOwnsWorker &&
      worker.state === "redundant" &&
      !this.hasPotentialSuccessor(worker)
    ) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.TARGET_DISCARDED,
        buildId,
      });
    }
  }

  preparedCandidate(worker, slot) {
    const buildId = this.serviceWorkerBuildIds.get(worker);
    const inExpectedSlot =
      (slot === "waiting" &&
        worker?.state === "installed" &&
        worker === this.registration?.waiting) ||
      (slot === "active" &&
        worker?.state === "activated" &&
        worker === this.registration?.active);
    if (
      !inExpectedSlot ||
      worker === this.firstInstallationServiceWorker ||
      !buildId ||
      buildId === this.currentBuildId
    ) {
      return null;
    }
    return { worker, buildId };
  }

  setPreparedServiceWorker(worker, buildId) {
    if (
      worker === this.readyServiceWorker &&
      buildId === this.readyServiceWorkerBuildId
    ) {
      return;
    }
    this.readyServiceWorker = worker;
    this.readyServiceWorkerBuildId = buildId;
    this.preparedGeneration += 1;
    if (
      this.handoffState.targetBuildId &&
      buildId !== this.handoffState.targetBuildId
    ) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED,
        buildId,
        generation: this.preparedGeneration,
        phase: this.phaseForWorker(worker, buildId),
      });
    }
  }

  syncHandoffState({ resumeHandoff }) {
    let buildId = this.handoffState.targetBuildId;
    if (!buildId) {
      return;
    }
    if (
      this.readyServiceWorkerBuildId &&
      this.readyServiceWorkerBuildId !== buildId &&
      this.preparedGeneration > this.handoffState.targetGeneration
    ) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED,
        buildId: this.readyServiceWorkerBuildId,
        generation: this.preparedGeneration,
        phase: this.phaseForWorker(
          this.readyServiceWorker,
          this.readyServiceWorkerBuildId,
        ),
      });
      buildId = this.handoffState.targetBuildId;
    }

    const controllerBuildId = this.controllerBuildId();
    if (controllerBuildId === buildId) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
        buildId,
      });
      return;
    }

    const phase = this.targetPhase();
    if (
      phase === PWA_UPDATE_TARGET_PHASE.REDUNDANT &&
      this.hasPotentialSuccessor(this.workerForBuild(buildId))
    ) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
        buildId,
        phase: PWA_UPDATE_TARGET_PHASE.MISSING,
      });
      return;
    }
    this.dispatchHandoff({
      type: PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED,
      buildId,
      phase,
    });
    if (resumeHandoff && this.handoffState.targetBuildId) {
      this.dispatchHandoff({
        type: PWA_UPDATE_HANDOFF_EVENT.RESUME_REQUESTED,
        buildId: this.handoffState.targetBuildId,
        phase: this.targetPhase(),
      });
    }
  }

  targetPhase() {
    const buildId = this.handoffState.targetBuildId;
    if (!buildId) {
      return PWA_UPDATE_TARGET_PHASE.MISSING;
    }
    return this.phaseForWorker(this.workerForBuild(buildId), buildId);
  }

  phaseForWorker(worker, buildId) {
    if (this.controllerBuildId() === buildId) {
      return PWA_UPDATE_TARGET_PHASE.CONTROLLED;
    }
    if (!worker) {
      return PWA_UPDATE_TARGET_PHASE.MISSING;
    }
    if (worker.state === "redundant") {
      return PWA_UPDATE_TARGET_PHASE.REDUNDANT;
    }
    if (
      worker.state === "installed" &&
      worker === this.registration?.waiting
    ) {
      return PWA_UPDATE_TARGET_PHASE.WAITING;
    }
    if (
      worker.state === "activated" &&
      worker === this.registration?.active
    ) {
      return PWA_UPDATE_TARGET_PHASE.ACTIVE;
    }
    if (["installing", "installed", "activating", "activated"].includes(
      worker.state,
    )) {
      return PWA_UPDATE_TARGET_PHASE.TRANSITIONING;
    }
    return PWA_UPDATE_TARGET_PHASE.MISSING;
  }

  controllerBuildId() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      return null;
    }
    const direct = this.serviceWorkerBuildIds.get(controller);
    if (direct) {
      return direct;
    }
    if (controller === this.registration?.active) {
      return this.serviceWorkerBuildIds.get(this.registration.active) ?? null;
    }
    return null;
  }

  workerForBuild(buildId) {
    if (!buildId) {
      return null;
    }
    for (const worker of [
      this.readyServiceWorker,
      this.registration?.waiting,
      this.registration?.active,
      this.registration?.installing,
      navigator.serviceWorker?.controller,
    ]) {
      if (worker && this.serviceWorkerBuildIds.get(worker) === buildId) {
        return worker;
      }
    }
    return this.serviceWorkersByBuildId.get(buildId) ?? null;
  }

  hasPotentialSuccessor(targetWorker) {
    return [this.registration?.installing, this.registration?.waiting].some(
      (worker) =>
        worker && worker !== targetWorker && worker.state !== "redundant",
    );
  }

  dispatchHandoff(event) {
    const transition = transitionPwaUpdateHandoff(this.handoffState, event);
    this.handoffState = transition.state;
    for (const effect of transition.effects) {
      this.performHandoffEffect(effect);
    }
  }

  performHandoffEffect(effect) {
    const worker = this.workerForBuild(effect.buildId);
    if (
      effect.type === PWA_UPDATE_HANDOFF_EFFECT.ACTIVATE_TARGET &&
      worker?.state === "installed" &&
      worker === this.registration?.waiting
    ) {
      worker.postMessage({ type: ACTIVATE_PREPARED_BUILD_MESSAGE });
      return;
    }
    if (
      effect.type === PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET &&
      worker?.state === "activated" &&
      worker === this.registration?.active &&
      this.controllerBuildId() !== effect.buildId
    ) {
      worker.postMessage({ type: CLAIM_PREPARED_BUILD_MESSAGE });
      return;
    }
    if (effect.type === PWA_UPDATE_HANDOFF_EFFECT.RELOAD) {
      this.onReloadReady();
    }
  }

  async pruneShellCachesIfSafe() {
    const controller = navigator.serviceWorker.controller;
    if (
      !controller ||
      this.handoffState.node !== PWA_UPDATE_HANDOFF_NODE.IDLE ||
      this.handoffState.targetBuildId ||
      this.readyServiceWorkerBuildId ||
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
      this.handoffState.node !== PWA_UPDATE_HANDOFF_NODE.IDLE ||
      this.handoffState.targetBuildId ||
      this.readyServiceWorkerBuildId ||
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
