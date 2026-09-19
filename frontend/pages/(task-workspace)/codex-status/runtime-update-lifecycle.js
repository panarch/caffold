const IDLE_UPDATE_STATE = Object.freeze({
  state: "idle",
  message: "",
});

export class CodexRuntimeUpdateLifecycle {
  constructor({ onStateChange, refreshStatus, updateRuntime }) {
    this.onStateChange = onStateChange;
    this.refreshStatus = refreshStatus;
    this.updateRuntime = updateRuntime;
    this.active = false;
    this.requestId = 0;
    this.pendingRequest = null;
    this.stateValue = IDLE_UPDATE_STATE;
  }

  connect() {
    this.active = true;
  }

  disconnect() {
    this.active = false;
    this.requestId += 1;
    this.pendingRequest = null;
    this.setState(IDLE_UPDATE_STATE);
  }

  snapshot() {
    return { ...this.stateValue };
  }

  reset() {
    if (!this.pendingRequest) {
      this.setState(IDLE_UPDATE_STATE);
    }
  }

  update() {
    if (!this.active) {
      return Promise.resolve(null);
    }
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    const requestId = ++this.requestId;
    this.setState({ state: "updating", message: "" });
    const request = this.runUpdate(requestId);
    this.pendingRequest = request;
    return request;
  }

  async runUpdate(requestId) {
    let outcome = null;
    try {
      outcome = await this.updateRuntime();
      if (!this.isCurrent(requestId)) {
        return null;
      }

      this.setState({ state: "refreshing", message: "" });
      await this.refreshStatus();
      if (!this.isCurrent(requestId)) {
        return null;
      }

      this.setState({
        state: outcome?.status === "unsupported" ? "failed" : "succeeded",
        message: outcomeMessage(outcome),
      });
      return outcome;
    } catch (error) {
      if (!this.isCurrent(requestId)) {
        return null;
      }
      const detail = error instanceof Error ? error.message : `${error}`;
      this.setState({
        state: "failed",
        message: outcome
          ? `${outcomeMessage(outcome)} Readiness could not be refreshed: ${detail}`
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

/**
 * `noUpdate` only says this run installed nothing; Codex's own message says
 * whether it still restarted a runtime older than the installation.
 */
function outcomeMessage(outcome) {
  const detail = outcome?.message ?? "";
  if (outcome?.status !== "updated") {
    return detail;
  }
  const headline = outcome.installedVersion
    ? `Codex updated to ${outcome.installedVersion}.`
    : "Codex updated.";
  return detail ? `${headline} ${detail}` : headline;
}
