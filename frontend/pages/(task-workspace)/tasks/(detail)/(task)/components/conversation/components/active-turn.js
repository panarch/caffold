import { activeTurnDuration } from "./active-turn/model.js";

class CaffoldTaskActiveTurn extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.initialized) {
      this.initialized = true;
      this.innerHTML = `
        <span class="task-active-turn-spinner" aria-hidden="true"></span>
        <span class="task-turn-active-duration"></span>
        <span class="task-turn-active-state" aria-live="polite"></span>
      `;
    }
    this.update();
  }

  disconnectedCallback() {
    this.stopClock();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.presentation = {
      startedMs: null,
      state: "Thinking",
    };
    this.active = true;
    this.clockTimer = null;
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const startedMs = Number(snapshot.startedMs);
    const next = {
      startedMs:
        Number.isFinite(startedMs) && startedMs > 0 ? startedMs : null,
      state: `${snapshot.state ?? "Thinking"}`,
    };
    if (
      this.presentation.startedMs === next.startedMs &&
      this.presentation.state === next.state
    ) {
      return false;
    }
    this.presentation = next;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  setActive(active) {
    this.ensureState();
    const nextActive = Boolean(active);
    if (this.active === nextActive) {
      return;
    }
    this.active = nextActive;
    if (this.active) {
      this.syncClock();
    } else {
      this.stopClock();
    }
  }

  update() {
    const state = this.querySelector(".task-turn-active-state");
    if (state) {
      patchText(state, this.presentation.state);
      if (state.title !== this.presentation.state) {
        state.title = this.presentation.state;
      }
    }
    this.syncClock();
  }

  syncClock() {
    if (!this.isConnected || !this.active) {
      this.stopClock();
      return;
    }
    this.updateClock();
    if (this.presentation.startedMs && !this.clockTimer) {
      this.clockTimer = window.setInterval(() => this.updateClock(), 1_000);
    } else if (!this.presentation.startedMs) {
      this.stopClock();
    }
  }

  updateClock() {
    const duration = this.querySelector(".task-turn-active-duration");
    if (!duration) {
      this.stopClock();
      return;
    }
    patchText(
      duration,
      activeTurnDuration(this.presentation.startedMs, Date.now()),
    );
  }

  stopClock() {
    window.clearInterval(this.clockTimer);
    this.clockTimer = null;
  }
}

function patchText(element, value) {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

if (!customElements.get("caffold-task-active-turn")) {
  customElements.define("caffold-task-active-turn", CaffoldTaskActiveTurn);
}
