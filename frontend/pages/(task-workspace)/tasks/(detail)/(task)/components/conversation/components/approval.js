import { escapeHtml } from "../../../../../../../../components/dom.js";
import { formatDecision } from "../../../../../task-format.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../../../../../scroll-scope.js";

// One normalized approval owns its presentation and local interactions. The
// Task API owner receives decisions as intent and supplies request errors.
class CaffoldTaskApproval extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.update();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) return;
    this.stateReady = true;
    this.threadId = "";
    this.request = {};
    this.errorMessage = "";
    this.disabled = false;
    this.active = true;
    this.initialized = false;
    this.detailsHtml = null;
    this.boundClick = (event) => this.handleClick(event);
  }

  get approvalId() {
    this.ensureState();
    return `${this.request.approvalId ?? ""}`;
  }

  setSnapshot({ threadId = "", request = {}, disabled = false } = {}) {
    this.ensureState();
    const identityChanged = this.threadId !== threadId ||
      this.approvalId !== `${request.approvalId ?? ""}`;
    if (identityChanged) {
      this.errorMessage = "";
      this.initialized = false;
      this.detailsHtml = null;
    }
    this.threadId = threadId;
    this.request = request;
    this.disabled = Boolean(disabled);
    if (this.isConnected) this.update();
  }

  setActive(active) {
    this.ensureState();
    this.active = Boolean(active);
    if (this.initialized) this.updateActions();
  }

  setError(error) {
    this.ensureState();
    this.errorMessage = error ? `${error.message ?? error}` : "";
    if (this.initialized) this.updateError();
  }

  update() {
    if (!this.initialized) {
      this.innerHTML = `
        <article class="task-approval-card">
          <header>
            <h3></h3>
            <p class="task-approval-reason" hidden></p>
          </header>
          <div class="task-approval-content"></div>
          <p class="task-approval-error" role="alert" hidden></p>
          <div class="task-approval-actions"></div>
        </article>
      `;
      this.initialized = true;
    }
    const card = this.querySelector(":scope > article");
    if (card.dataset.approvalId !== this.approvalId) {
      card.dataset.approvalId = this.approvalId;
    }
    patchText(card.querySelector(":scope > header > h3"), this.request.title ?? "Approval requested");
    const reason = card.querySelector(":scope > header > .task-approval-reason");
    patchText(reason, this.request.reason ?? "");
    patchHidden(reason, !this.request.reason);
    const detailsHtml = renderApprovalDetails(this.request);
    if (this.detailsHtml !== detailsHtml) {
      card.querySelector(":scope > .task-approval-content").innerHTML = detailsHtml;
      this.detailsHtml = detailsHtml;
    }
    this.updateActions();
    this.updateError();
  }

  updateActions() {
    const container = this.querySelector(":scope > article > .task-approval-actions");
    const existing = new Map(this.actions().map((button) => [button.dataset.decision, button]));
    const offered = Array.isArray(this.request.decisions) ? this.request.decisions : [];
    const desired = offered.map((decision) => {
      let button = existing.get(decision);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "task-secondary-button";
        button.dataset.taskAction = "approval";
        button.dataset.decision = decision;
        button.textContent = formatDecision(decision);
      }
      if (button.dataset.approvalId !== this.approvalId) {
        button.dataset.approvalId = this.approvalId;
      }
      const disabled = this.disabled || !this.active;
      if (button.disabled !== disabled) button.disabled = disabled;
      return button;
    });
    const retained = new Set(desired);
    for (const button of existing.values()) {
      if (!retained.has(button)) button.remove();
    }
    let anchor = null;
    for (let index = desired.length - 1; index >= 0; index -= 1) {
      const button = desired[index];
      if (button.parentElement !== container || button.nextElementSibling !== anchor) {
        container.insertBefore(button, anchor);
      }
      anchor = button;
    }
  }

  updateError() {
    const error = this.querySelector(":scope > article > .task-approval-error");
    patchText(error, this.errorMessage);
    patchHidden(error, !this.errorMessage);
  }

  actions() {
    return Array.from(this.querySelectorAll(":scope > article > .task-approval-actions > button"));
  }

  handleClick(event) {
    const control = event.target instanceof Element
      ? event.target.closest("button[data-decision]")
      : null;
    if (!control || !this.actions().includes(control)) return;
    event.stopPropagation();
    if (!this.isConnected || !this.active || this.hidden || this.disabled || control.disabled) return;
    const decision = control.dataset.decision;
    if (!this.request.decisions?.includes(decision)) return;
    this.dispatchEvent(new CustomEvent("caffold:task-approval-intent", {
      bubbles: true,
      detail: { threadId: this.threadId, approvalId: this.approvalId, decision },
    }));
  }

  actionHintScope({ scopeId = "", clipRoots = [], isCurrent = () => true } = {}) {
    this.ensureState();
    if (!scopeId || !this.approvalId || !this.active || this.hidden || this.disabled) {
      return emptyActionHintScope();
    }
    const approvalId = this.approvalId;
    const threadId = this.threadId;
    return {
      blocked: false,
      targets: this.actions().filter((control) => !control.disabled).map((control) => {
        const decision = control.dataset.decision;
        return buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${decision}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: control.textContent,
          control,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected && this.active && !this.hidden && !this.disabled &&
            isCurrent() && this.threadId === threadId && this.approvalId === approvalId &&
            this.actions().includes(control) && control.dataset.decision === decision &&
            this.request.decisions?.includes(decision) && !control.disabled,
        });
      }),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope({ scopeId = "", clipRoots = [], isCurrent = () => true } = {}) {
    this.ensureState();
    if (!scopeId || !this.approvalId || !this.active || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const approvalId = this.approvalId;
    const threadId = this.threadId;
    const outputs = Array.from(this.querySelectorAll(":scope > article > .task-approval-content pre"));
    return {
      blocked: false,
      surfaces: outputs.map((scrollport, index) => ({
        id: `${scopeId}:output:${index}`,
        label: scrollport.getAttribute("aria-label") || "Approval details",
        scrollport,
        axes: ["horizontal"],
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected && this.active && !this.hidden && isCurrent() &&
          this.threadId === threadId && this.approvalId === approvalId &&
          this.contains(scrollport) && hasScrollLayoutBox(this) && hasScrollLayoutBox(scrollport),
      })),
      mutationRoots: [this],
      resizeElements: [this, ...outputs],
      scrollRoots: outputs,
    };
  }
}

function patchText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function patchHidden(element, hidden) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/**
 * The specifics of one request, in the order a reader checks them: what would
 * run, what it would reach, and where. Every part is optional because requests
 * differ, so this renders what is present rather than switching on a kind.
 */
function renderApprovalDetails(payload) {
  const command = `${payload.command ?? ""}`.trim();
  const sections = [
    renderToolApprovalDetails(payload.tool),
    command
      ? `<pre class="task-approval-command" tabindex="0" aria-label="Approval command"><code>${escapeHtml(command)}</code></pre>`
      : "",
    payload.networkEndpoint
      ? renderApprovalDefinitionList(
          [
            {
              label: "Network destination",
              value: `${payload.networkEndpoint}`,
              code: true,
            },
          ],
          "Network request",
        )
      : "",
    renderPermissionRows(payload.permissions),
    renderApprovalContext(payload),
  ];
  return sections.filter(Boolean).join("");
}

function renderToolApprovalDetails(tool) {
  if (!tool) return "";
  const context = [
    { label: "Server", value: tool.serverName, code: true },
    ...(tool.appName ? [{ label: "App", value: tool.appName }] : []),
  ];
  const argumentsHtml = (tool.arguments ?? []).map((argument) => `
    <div>
      <dt>${escapeHtml(argument.label)}${argument.label !== argument.name ? ` <code>(${escapeHtml(argument.name)})</code>` : ""}</dt>
      <dd><pre tabindex="0" aria-label="${escapeHtml(argument.label)}"><code>${escapeHtml(JSON.stringify(argument.value, null, 2))}</code></pre></dd>
    </div>
  `).join("");
  return `
    ${renderApprovalDefinitionList(context, "Tool context")}
    ${tool.description ? `<p class="task-approval-reason">${escapeHtml(tool.description)}</p>` : ""}
    ${argumentsHtml ? `<dl class="task-approval-arguments" aria-label="Tool arguments">${argumentsHtml}</dl>` : ""}
  `;
}

function renderPermissionRows(permissions) {
  if (!Array.isArray(permissions) || !permissions.length) {
    return "";
  }
  return renderApprovalDefinitionList(
    permissions.map((row) => ({
      label: `${row?.label ?? ""}`,
      value: `${row?.value ?? ""}`,
      code: Boolean(row?.verbatim),
    })),
    "Requested permissions",
  );
}

function renderApprovalContext(payload) {
  const rows = [
    ["Grant root", payload.grantRoot],
    ["Working directory", payload.cwd],
    ["Environment", payload.environment],
  ]
    .filter(([, value]) => `${value ?? ""}`.trim())
    .map(([label, value]) => ({ label, value: `${value}`, code: true }));
  return rows.length ? renderApprovalDefinitionList(rows, "Request context") : "";
}

function renderApprovalDefinitionList(rows, label) {
  return `
    <dl class="task-approval-details" aria-label="${escapeHtml(label)}">
      ${rows
        .map(
          (row) => `<div>
            <dt>${escapeHtml(row.label)}</dt>
            <dd>${row.code ? `<code>${renderBreakableCode(row.value)}</code>` : escapeHtml(row.value)}</dd>
          </div>`,
        )
        .join("")}
    </dl>
  `;
}

function renderBreakableCode(value) {
  return escapeHtml(value)
    .replaceAll("/", "/<wbr>")
    .replaceAll("\\", "\\<wbr>");
}

if (!customElements.get("caffold-task-approval")) {
  customElements.define("caffold-task-approval", CaffoldTaskApproval);
}
