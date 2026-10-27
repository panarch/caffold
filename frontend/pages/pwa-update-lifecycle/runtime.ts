import {
  createPwaUpdateHandoffState,
  PWA_UPDATE_HANDOFF_EFFECT,
  PWA_UPDATE_HANDOFF_EVENT,
  PWA_UPDATE_HANDOFF_NODE,
  PWA_UPDATE_TARGET_PHASE,
  type PwaUpdateHandoffEffect,
  type PwaUpdateHandoffEvent,
  type PwaUpdateHandoffNode,
  type PwaUpdateHandoffState,
  type PwaUpdateTargetPhase,
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

// What the PWA update lifecycle says: whether it is still checking, the
// build it has prepared for this window, and how the handoff stands.
export interface PwaUpdateSnapshot {
  state: "checking" | "ready" | "settled";
  preparedUpdate: { ready: boolean; buildId: string | null };
  diagnostics: {
    handoffNode: PwaUpdateHandoffNode;
    targetBuildId: string | null;
    controllerBuildId: string | null;
    activeBuildId: string | null;
    waitingBuildId: string | null;
    navigationAttemptCount: number;
    lastNavigationAttemptBuildId: string | null;
  };
}

export interface PwaUpdateOptions {
  currentBuildId: string;
  onReloadReady: () => void;
  onStatusChange: (status: PwaUpdateSnapshot) => void;
}

type Slot = "waiting" | "active";

export class PwaUpdateRuntime {
  private readonly currentBuildId: string;
  private readonly onReloadReady: () => void;
  private readonly onStatusChange: (status: PwaUpdateSnapshot) => void;
  private serverBuildId: string | null;
  private connected: boolean;
  private registration: ServiceWorkerRegistration | null;
  private registrationSettled: boolean;
  private registrationRequest: Promise<ServiceWorkerRegistration | null> | null;
  private updateIntervalId: number | null;
  private updateRequest: Promise<ServiceWorkerRegistration | null> | null;
  private settledCheckServerBuildId: string | null;
  private readyServiceWorker: ServiceWorker | null;
  private readyServiceWorkerBuildId: string | null;
  private preparedGeneration: number;
  private readonly serviceWorkerBuildIds: WeakMap<ServiceWorker, string>;
  private readonly serviceWorkersByBuildId: Map<string, ServiceWorker>;
  private readonly observedServiceWorkers: Map<ServiceWorker, () => void>;
  private handoffState: PwaUpdateHandoffState;
  private navigationAttemptCount: number;
  private lastNavigationAttemptBuildId: string | null;
  private readonly startedWithServiceWorkerController: boolean;
  private firstInstallationServiceWorker: ServiceWorker | null;
  private suppressNextServiceWorkerAsFirstInstall: boolean;
  private lastStatusKey: string | null;
  private readonly boundUpdateFound: () => void;
  private readonly boundMessage: (event: MessageEvent) => void;
  private readonly boundControllerChange: () => void;
  private readonly boundResume: () => void;
  private readonly boundPageShow: (event: PageTransitionEvent) => void;
  private readonly boundOnline: () => void;

  constructor({
    currentBuildId,
    onReloadReady,
    onStatusChange,
  }: PwaUpdateOptions) {
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
    this.navigationAttemptCount = 0;
    this.lastNavigationAttemptBuildId = null;
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

  start(): Promise<ServiceWorkerRegistration | null> {
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
            registration.active ??
            registration.waiting ??
            registration.installing;
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

  setServerBuildId(buildId: unknown) {
    this.serverBuildId =
      typeof buildId === "string" && buildId ? buildId : null;
    if (this.serverBuildId === this.currentBuildId) {
      this.settledCheckServerBuildId = this.serverBuildId;
    }
    this.emitStatus();
    this.ensureServerBuildChecked();
  }

  snapshot(): PwaUpdateSnapshot {
    return {
      state: this.updateState(),
      preparedUpdate: {
        ready: Boolean(this.readyServiceWorkerBuildId),
        buildId: this.readyServiceWorkerBuildId,
      },
      diagnostics: {
        handoffNode: this.handoffState.node,
        targetBuildId: this.handoffState.targetBuildId,
        controllerBuildId: this.controllerBuildId(),
        activeBuildId: this.buildIdOf(this.registration?.active) ?? null,
        waitingBuildId: this.buildIdOf(this.registration?.waiting) ?? null,
        navigationAttemptCount: this.navigationAttemptCount,
        lastNavigationAttemptBuildId: this.lastNavigationAttemptBuildId,
      },
    };
  }

  checkForUpdate(): Promise<ServiceWorkerRegistration | null> | null {
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
          this.syncServiceWorkerState({ resumeHandoff: false });
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

  private attachRegistration() {
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

  private attachUpdateChecks() {
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

  private handleUpdateFound() {
    const worker = this.registration?.installing;
    if (worker && this.suppressNextServiceWorkerAsFirstInstall) {
      this.firstInstallationServiceWorker = worker;
      this.suppressNextServiceWorkerAsFirstInstall = false;
    }
    this.syncServiceWorkerState({ resumeHandoff: false });
  }

  private handleMessage(event: MessageEvent) {
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
      this.syncServiceWorkerState({ resumeHandoff: false });
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
    const worker = event.source as ServiceWorker;
    this.recordServiceWorkerBuild(worker, buildId);
    this.observeServiceWorker(worker);
    this.syncServiceWorkerState({ resumeHandoff: false });
  }

  private observeServiceWorker(worker: ServiceWorker | null | undefined) {
    if (!this.connected || !worker || this.observedServiceWorkers.has(worker)) {
      return;
    }
    const listener = () =>
      this.syncServiceWorkerState({ resumeHandoff: false });
    this.observedServiceWorkers.set(worker, listener);
    worker.addEventListener("statechange", listener);
  }

  private recordServiceWorkerBuild(worker: ServiceWorker, buildId: string) {
    this.serviceWorkerBuildIds.set(worker, buildId);
    this.serviceWorkersByBuildId.set(buildId, worker);
  }

  private syncServiceWorkerState({
    resumeHandoff = false,
  }: {
    resumeHandoff?: boolean;
  } = {}) {
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
        worker &&
        ["installed", "activated"].includes(worker.state) &&
        !this.serviceWorkerBuildIds.has(worker)
      ) {
        worker.postMessage({ type: GET_SERVICE_WORKER_BUILD_ID_MESSAGE });
      }
    }
    this.syncHandoffState({ resumeHandoff });
    this.emitStatus();
    this.ensureServerBuildChecked();
  }

  private reconcilePreparedServiceWorker() {
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

  private preparedCandidate(
    worker: ServiceWorker | null | undefined,
    slot: Slot,
  ) {
    const buildId = this.buildIdOf(worker);
    const inExpectedSlot =
      (slot === "waiting" &&
        worker?.state === "installed" &&
        worker === this.registration?.waiting) ||
      (slot === "active" &&
        worker?.state === "activated" &&
        worker === this.registration?.active);
    if (
      !worker ||
      !inExpectedSlot ||
      worker === this.firstInstallationServiceWorker ||
      !buildId ||
      buildId === this.currentBuildId
    ) {
      return null;
    }
    return { worker, buildId };
  }

  private setPreparedServiceWorker(worker: ServiceWorker, buildId: string) {
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

  private syncHandoffState({ resumeHandoff }: { resumeHandoff: boolean }) {
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

  private targetPhase(): PwaUpdateTargetPhase {
    const buildId = this.handoffState.targetBuildId;
    if (!buildId) {
      return PWA_UPDATE_TARGET_PHASE.MISSING;
    }
    return this.phaseForWorker(this.workerForBuild(buildId), buildId);
  }

  private phaseForWorker(
    worker: ServiceWorker | null,
    buildId: string | null,
  ): PwaUpdateTargetPhase {
    if (this.controllerBuildId() === buildId) {
      return PWA_UPDATE_TARGET_PHASE.CONTROLLED;
    }
    if (!worker) {
      return PWA_UPDATE_TARGET_PHASE.MISSING;
    }
    if (worker.state === "redundant") {
      return PWA_UPDATE_TARGET_PHASE.REDUNDANT;
    }
    if (worker.state === "installed" && worker === this.registration?.waiting) {
      return PWA_UPDATE_TARGET_PHASE.WAITING;
    }
    if (worker.state === "activated" && worker === this.registration?.active) {
      return PWA_UPDATE_TARGET_PHASE.ACTIVE;
    }
    if (
      ["installing", "installed", "activating", "activated"].includes(
        worker.state,
      )
    ) {
      return PWA_UPDATE_TARGET_PHASE.TRANSITIONING;
    }
    return PWA_UPDATE_TARGET_PHASE.MISSING;
  }

  private controllerBuildId() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      return null;
    }
    const direct = this.serviceWorkerBuildIds.get(controller);
    if (direct) {
      return direct;
    }
    if (controller === this.registration?.active) {
      return this.buildIdOf(this.registration.active) ?? null;
    }
    return null;
  }

  private buildIdOf(worker: ServiceWorker | null | undefined) {
    return worker ? this.serviceWorkerBuildIds.get(worker) : undefined;
  }

  private workerForBuild(buildId: string | null) {
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

  private hasPotentialSuccessor(targetWorker: ServiceWorker | null) {
    return [this.registration?.installing, this.registration?.waiting].some(
      (worker) =>
        worker && worker !== targetWorker && worker.state !== "redundant",
    );
  }

  private dispatchHandoff(event: PwaUpdateHandoffEvent) {
    const transition = transitionPwaUpdateHandoff(this.handoffState, event);
    this.handoffState = transition.state;
    for (const effect of transition.effects) {
      this.performHandoffEffect(effect);
    }
  }

  private performHandoffEffect(effect: PwaUpdateHandoffEffect) {
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
      this.navigationAttemptCount += 1;
      this.lastNavigationAttemptBuildId = effect.buildId;
      this.onReloadReady();
    }
  }

  private async pruneShellCachesIfSafe() {
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
    let cacheNames: string[];
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

  private ensureServerBuildChecked() {
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

  private updateState(): PwaUpdateSnapshot["state"] {
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

  private hasUnsettledReplacementWorker() {
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

  private emitStatus() {
    if (!this.connected) {
      return;
    }
    const status = this.snapshot();
    const statusKey = [
      status.state,
      status.preparedUpdate.ready,
      status.preparedUpdate.buildId,
      status.diagnostics.handoffNode,
      status.diagnostics.targetBuildId,
      status.diagnostics.controllerBuildId,
      status.diagnostics.activeBuildId,
      status.diagnostics.waitingBuildId,
      status.diagnostics.navigationAttemptCount,
      status.diagnostics.lastNavigationAttemptBuildId,
    ].join(":");
    if (statusKey === this.lastStatusKey) {
      return;
    }
    this.lastStatusKey = statusKey;
    this.onStatusChange(status);
  }
}
