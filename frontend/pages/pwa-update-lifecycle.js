import { PwaUpdateRuntime } from "./pwa-update-lifecycle/runtime.js";

// Public feature owner. Registration details and the handoff graph remain private.
export class PwaUpdateLifecycle {
  constructor(options) {
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

  setServerBuildId(buildId) {
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
