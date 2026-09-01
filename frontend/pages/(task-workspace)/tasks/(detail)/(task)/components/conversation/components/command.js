import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../components/icons.js";
import {
  commandPresentation,
  sameCommandPresentation,
} from "./command/model.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../action-hints.js";

class CaffoldTaskCommand extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.attachListeners();
    if (!this.initialized) {
      this.initialized = true;
      this.update();
    } else {
      this.restoreDisclosureState();
      this.refreshDisclosureIcons();
    }
    warmIcons();
  }

  disconnectedCallback() {
    this.rememberDisclosureState();
    this.detachListeners();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.presentation = commandPresentation();
    this.disclosureOpenState = this.presentation.defaultOpen;
    this.renderedMode = "";
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.refreshDisclosureIcons();
  }

  attachListeners() {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  detachListeners() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setSnapshot(event = {}) {
    this.ensureState();
    const next = commandPresentation(event);
    if (sameCommandPresentation(this.presentation, next)) {
      return false;
    }
    if (this.presentation.commandKey === next.commandKey) {
      this.rememberDisclosureState();
    } else {
      this.disclosureOpenState = next.defaultOpen;
    }
    this.presentation = next;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  get commandKey() {
    this.ensureState();
    return this.presentation.commandKey;
  }

  disclosureOpen() {
    return Boolean(this.disclosure()?.open);
  }

  disclosureAnchorTop() {
    return this.disclosure()
      ?.querySelector(":scope > summary")
      ?.getBoundingClientRect().top ?? null;
  }

  update() {
    this.dataset.commandStatus = this.presentation.status;
    this.dataset.commandTone = this.presentation.tone;
    this.toggleAttribute(
      "data-command-terminal",
      this.presentation.mode === "terminal",
    );
    if (this.renderedMode !== this.presentation.mode) {
      this.innerHTML =
        this.presentation.mode === "terminal"
          ? renderTerminalCommand(this.presentation)
          : renderActiveCommand(this.presentation);
      this.renderedMode = this.presentation.mode;
    } else if (this.presentation.mode === "terminal") {
      this.patchTerminalCommand();
    } else {
      this.patchActiveCommand();
    }
    this.restoreDisclosureState();
    this.refreshDisclosureIcons();
  }

  patchActiveCommand() {
    patchText(
      this.querySelector(".task-command-active-status"),
      this.presentation.statusLabel,
    );
    patchText(
      this.querySelector(".task-command-active-time"),
      this.presentation.time,
    );
    patchText(
      this.querySelector(".task-command-active-output"),
      activeCommandText(this.presentation),
    );
  }

  patchTerminalCommand() {
    const status = this.querySelector(".task-command-summary-status");
    status.dataset.commandResult = this.presentation.result;
    patchText(status, this.presentation.statusLabel);
    patchText(
      this.querySelector(".task-command-summary-label"),
      this.presentation.commandLine,
    );
    const metadata = this.querySelector(".task-command-summary-meta");
    metadata.hidden = !this.presentation.metadata;
    patchText(metadata, this.presentation.metadata);
    this.action().dataset.commandKey = this.presentation.commandKey;
  }

  handleClick(event) {
    const action =
      event.target instanceof Element
        ? event.target.closest('[data-command-action="command-output"]')
        : null;
    if (action && this.contains(action)) {
      event.stopPropagation();
      if (this.commandKey) {
        this.dispatchEvent(
          new CustomEvent("caffold:task-command-intent", {
            bubbles: true,
            composed: true,
            detail: { type: "command-output", commandKey: this.commandKey },
          }),
        );
      }
      return;
    }

    const summary =
      event.target instanceof Element
        ? event.target.closest(".task-command-active-summary")
        : null;
    const disclosure = summary?.parentElement;
    if (
      !(disclosure instanceof HTMLDetailsElement) ||
      disclosure !== this.disclosure()
    ) {
      return;
    }
    const open = !disclosure.open;
    this.disclosureOpenState = open;
    this.dispatchEvent(
      new CustomEvent("caffold:task-command-disclosure-intent", {
        bubbles: true,
        composed: true,
        detail: { commandKey: this.commandKey, open },
      }),
    );
  }

  disclosure() {
    return this.querySelector(":scope > details.task-command-active");
  }

  action() {
    return this.querySelector(
      ":scope > .task-command-summary .task-command-summary-action",
    );
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const control = this.action();
    const commandKey = this.commandKey;
    if (
      !scopeId ||
      !commandKey ||
      this.presentation.mode !== "terminal" ||
      !control ||
      control.disabled
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: `${scopeId}:view-output`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          "View output",
        control,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          this.commandKey === commandKey &&
          this.presentation.mode === "terminal" &&
          this.action() === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  rememberDisclosureState() {
    const disclosure = this.disclosure();
    if (disclosure) {
      this.disclosureOpenState = disclosure.open;
    }
  }

  restoreDisclosureState() {
    const disclosure = this.disclosure();
    if (disclosure) {
      disclosure.toggleAttribute("open", this.disclosureOpenState);
    }
  }

  refreshDisclosureIcons() {
    const chevron = this.querySelector(".task-command-disclosure-chevron");
    if (!chevron) {
      return;
    }
    chevron.innerHTML = `
      ${renderInlineIcon(
        "ChevronRight",
        "Collapsed",
        "task-command-disclosure-chevron-icon task-command-disclosure-chevron-collapsed",
      )}
      ${renderInlineIcon(
        "ChevronDown",
        "Expanded",
        "task-command-disclosure-chevron-icon task-command-disclosure-chevron-expanded",
      )}
    `;
  }
}

function renderActiveCommand(presentation) {
  return `
    <details class="task-command-active">
      <summary class="task-command-active-summary">
        <span class="task-command-active-label">
          <span>Command</span>
          <span class="task-command-disclosure-chevron" aria-hidden="true"></span>
        </span>
        <span class="task-command-active-status">${escapeHtml(presentation.statusLabel)}</span>
        <time class="task-command-active-time">${escapeHtml(presentation.time)}</time>
      </summary>
      <pre class="task-command-active-output">${escapeHtml(activeCommandText(presentation))}</pre>
    </details>
  `;
}

function renderTerminalCommand(presentation) {
  return `
    <div class="task-command-summary">
      <span class="task-command-summary-status" data-command-result="${escapeHtml(presentation.result)}">${escapeHtml(presentation.statusLabel)}</span>
      <code class="task-command-summary-label">${escapeHtml(presentation.commandLine)}</code>
      <span class="task-command-summary-meta"${presentation.metadata ? "" : " hidden"}>${escapeHtml(presentation.metadata)}</span>
      <button
        type="button"
        class="task-command-summary-action"
        data-command-action="command-output"
        data-command-key="${escapeHtml(presentation.commandKey)}"
        aria-haspopup="dialog"
      >View output</button>
    </div>
  `;
}

function activeCommandText(presentation) {
  return [
    `$ ${presentation.command}`,
    presentation.cwd ? `cwd: ${presentation.cwd}` : "",
    presentation.status ? `status: ${presentation.status}` : "",
    presentation.output,
  ]
    .filter(Boolean)
    .join("\n");
}

function patchText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

if (!customElements.get("caffold-task-command")) {
  customElements.define("caffold-task-command", CaffoldTaskCommand);
}
