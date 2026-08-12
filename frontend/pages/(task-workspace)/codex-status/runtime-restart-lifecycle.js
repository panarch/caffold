const IDLE_RESTART_STATE = Object.freeze({
  state: "idle",
  message: "",
});

export class CodexRuntimeRestartLifecycle {
  constructor({ onStateChange, refreshStatus, restartRuntime }) {
    this.onStateChange = onStateChange;
    this.refreshStatus = refreshStatus;
    this.restartRuntime = restartRuntime;
    this.active = false;
    this.requestId = 0;
    this.pendingRequest = null;
    this.stateValue = IDLE_RESTART_STATE;
  }

  connect() {
    this.active = true;
  }

  disconnect() {
    this.active = false;
    this.requestId += 1;
    this.pendingRequest = null;
    this.setState(IDLE_RESTART_STATE);
  }

  snapshot() {
    return { ...this.stateValue };
  }

  reset() {
    if (!this.pendingRequest) {
      this.setState(IDLE_RESTART_STATE);
    }
  }

  restart() {
    if (!this.active) {
      return Promise.resolve(null);
    }
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    const requestId = ++this.requestId;
    this.setState({ state: "restarting", message: "" });
    const request = this.runRestart(requestId);
    this.pendingRequest = request;
    return request;
  }

  async runRestart(requestId) {
    let runtimeRestarted = false;
    try {
      await this.restartRuntime();
      runtimeRestarted = true;
      if (!this.isCurrent(requestId)) {
        return null;
      }

      this.setState({ state: "refreshing", message: "" });
      const status = await this.refreshStatus();
      if (!this.isCurrent(requestId)) {
        return null;
      }
      if (status?.readiness?.state === "restartRequired") {
        this.setState({
          state: "failed",
          message: "Codex still reports that the shared runtime must be restarted.",
        });
        return status;
      }

      this.setState({
        state: "succeeded",
        message: "Codex runtime restarted.",
      });
      return status;
    } catch (error) {
      if (!this.isCurrent(requestId)) {
        return null;
      }
      const detail = error instanceof Error ? error.message : `${error}`;
      this.setState({
        state: "failed",
        message: runtimeRestarted
          ? `Codex runtime restarted, but readiness could not be refreshed: ${detail}`
          : detail,
      });
      return null;
    } finally {
      if (requestId === this.requestId) {
        this.pendingRequest = null;
      }
    }
  }

  isCurrent(requestId) {
    return this.active && requestId === this.requestId;
  }

  setState(value) {
    if (
      this.stateValue.state === value.state &&
      this.stateValue.message === value.message
    ) {
      return;
    }
    this.stateValue = Object.freeze({ ...value });
    this.onStateChange?.(this.snapshot());
  }
}
