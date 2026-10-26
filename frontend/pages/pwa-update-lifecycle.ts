import {
  type PwaUpdateOptions,
  PwaUpdateRuntime,
} from "./pwa-update-lifecycle/runtime.ts";

// Public feature owner. Registration details and the handoff graph remain private.
export class PwaUpdateLifecycle {
  private readonly runtime: PwaUpdateRuntime;

  constructor(options: PwaUpdateOptions) {
    this.runtime = new PwaUpdateRuntime(options);
  }

  start() {
    return this.runtime.start();
  }

  connect() {
    this.runtime.connect();
  }

  disconnect() {
    this.runtime.disconnect();
  }

  setServerBuildId(buildId: unknown) {
    this.runtime.setServerBuildId(buildId);
  }

  snapshot() {
    return this.runtime.snapshot();
  }

  checkForUpdate() {
    return this.runtime.checkForUpdate();
  }

  activatePreparedUpdate() {
    this.runtime.activatePreparedUpdate();
  }
}
