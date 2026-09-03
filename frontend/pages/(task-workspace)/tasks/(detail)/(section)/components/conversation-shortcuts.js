import {
  codexBlocksTaskOperations,
  codexState,
  taskStoreBlocksTaskOperations,
} from "../../../../codex-status.js";
import "./conversation-shortcuts/components/fork-dialog.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../action-hints.js";

class CaffoldSectionConversationShortcuts extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureRendered();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("click", this.boundClick);
  }

  disconnectedCallback() {
    this.deactivate();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.active = false;
    this.context = { key: "", sectionId: "", path: "" };
    this.transportAvailable = true;
    this.codexStatusSnapshot = null;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .section-conversations-heading")) {
      return;
    }
    this.setAttribute("role", "complementary");
    this.setAttribute("aria-label", "Existing conversations");
    this.innerHTML = `
      <header class="section-conversations-heading">
        <h2>Existing conversations</h2>
        <p>Create a Task here with an existing conversation's history.</p>
      </header>
      <button
        type="button"
        class="section-conversations-action"
        data-section-conversation-action="fork-codex"
        aria-describedby="section-conversations-codex-reason"
      >
        <span class="section-conversations-action-label">Fork from Codex thread ID</span>
        <span
          id="section-conversations-codex-reason"
          class="section-conversations-action-reason"
          hidden
        ></span>
      </button>
      <caffold-conversation-fork-dialog></caffold-conversation-fork-dialog>
    `;
    this.patch();
  }

  setContext({ key = "", sectionId = "", path = "" } = {}) {
    this.ensureRendered();
    const previousKey = this.context.key;
    this.context = {
      key: `${key}`,
      sectionId: `${sectionId}`,
      path: `${path}`,
    };
    if (previousKey && previousKey !== this.context.key) {
      this.forkDialog()?.deactivate();
    }
    this.patch();
  }

  setTransportAvailable(available) {
    this.ensureRendered();
    this.transportAvailable = Boolean(available);
    this.patch();
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureRendered();
    this.codexStatusSnapshot = snapshot ?? null;
    this.patch();
  }

  activate() {
    this.ensureRendered();
    this.active = true;
    this.patch();
  }

  deactivate() {
    this.active = false;
    this.forkDialog()?.deactivate();
    this.patch();
  }

  forkDialog() {
    return this.querySelector(":scope > caffold-conversation-fork-dialog");
  }

  actionHintScope({ scopeId = "section", clipRoots = [] } = {}) {
    this.ensureRendered();
    const selector =
      'button[data-section-conversation-action="fork-codex"]';
    const control = this.querySelector(selector);
    const contextKey = this.context.key;
    if (
      !this.active ||
      this.hidden ||
      !contextKey ||
      !control ||
      control.disabled
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:fork-conversation`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          "Fork from Codex thread ID",
        control,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          this.active &&
          !this.hidden &&
          this.context.key === contextKey &&
          this.querySelector(selector) === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    return this.active && !this.hidden
      ? this.forkDialog()?.keyboardNavigationContexts?.() ?? []
      : [];
  }

  patch() {
    const state = codexState(this.codexStatusSnapshot);
    const known = state !== "pending";
    this.toggleAttribute("hidden", !this.active || !known);

    const reason = this.disabledReason(state);
    const button = this.querySelector("[data-section-conversation-action='fork-codex']");
    const reasonElement = this.querySelector(".section-conversations-action-reason");
    if (!button || !reasonElement) {
      return;
    }
    button.disabled = Boolean(reason);
    button.title = reason;
    reasonElement.textContent = reason;
    reasonElement.hidden = !reason;
  }

  disabledReason(state) {
    if (!this.context.sectionId) {
      return "The target Section is unavailable.";
    }
    if (!this.transportAvailable) {
      return "Reconnect to Caffold to fork a conversation.";
    }
    const status = this.codexStatusSnapshot?.status;
    if (taskStoreBlocksTaskOperations(status)) {
      return status?.taskStoreReadiness?.diagnosticMessage ||
        "Tasks are temporarily unavailable.";
    }
    if (state !== "available" || codexBlocksTaskOperations(status)) {
      return status?.readiness?.diagnosticMessage ||
        this.codexStatusSnapshot?.error ||
        "Codex is temporarily unavailable.";
    }
    return "";
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("[data-section-conversation-action='fork-codex']")
      : null;
    if (!button || !this.contains(button) || button.disabled) {
      return;
    }
    this.forkDialog()?.open({
      sectionId: this.context.sectionId,
      sectionPath: this.context.path,
      opener: button,
    });
  }
}

if (!customElements.get("caffold-section-conversation-shortcuts")) {
  customElements.define(
    "caffold-section-conversation-shortcuts",
    CaffoldSectionConversationShortcuts,
  );
}
