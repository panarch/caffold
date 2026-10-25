import { html, LitElement, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { ApprovalTool, TaskEventPayload } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { formatDecision } from "#tasks/task-format.js";

export interface ApprovalIntentDetail {
  threadId: string;
  approvalId: string;
  decision: string;
}

interface DefinitionRow {
  label: string;
  value: string;
  code?: boolean;
}

// One pending approval: what is asked, and the decisions on offer. The
// conversation hands over the request and receives the chosen decision as
// intent; the Task API owner reports a request error, which the card shows
// until it is handed a different approval.
export class CaffoldTaskApproval extends LitElement {
  static properties = {
    threadId: { attribute: false },
    request: { attribute: false },
    disabled: { attribute: false },
    active: { attribute: false },
    errorMessage: { state: true },
  };

  declare threadId: string;
  declare request: TaskEventPayload;
  declare disabled: boolean;
  declare active: boolean;
  declare errorMessage: string;

  constructor() {
    super();
    this.threadId = "";
    this.request = {};
    this.disabled = false;
    this.active = true;
    this.errorMessage = "";
  }

  createRenderRoot() {
    return this;
  }

  get approvalId() {
    return this.request.approvalId ?? "";
  }

  setError(error: Error | null) {
    this.errorMessage = error?.message ?? "";
  }

  willUpdate(changed: PropertyValues<this>) {
    const threadId = changed.has("threadId")
      ? changed.get("threadId")
      : this.threadId;
    const approvalId = changed.has("request")
      ? (changed.get("request")?.approvalId ?? "")
      : this.approvalId;
    if (threadId !== this.threadId || approvalId !== this.approvalId) {
      this.errorMessage = "";
    }
  }

  render() {
    const { request, approvalId } = this;
    const offered = Array.isArray(request.decisions) ? request.decisions : [];
    return html`
      <article class="task-approval-card" data-approval-id=${approvalId}>
        <header>
          <h3>${request.title ?? "Approval requested"}</h3>
          <p
            class="task-approval-reason"
            ?hidden=${!request.reason}
          >${request.reason ?? ""}</p>
        </header>
        <div class="task-approval-content">${approvalDetails(request)}</div>
        <p
          class="task-approval-error"
          role="alert"
          ?hidden=${!this.errorMessage}
        >${this.errorMessage}</p>
        <div class="task-approval-actions">${repeat(
          offered,
          (decision) => decision,
          (decision) => html`<button
            type="button"
            class="task-secondary-button"
            data-task-action="approval"
            data-decision=${decision}
            data-approval-id=${approvalId}
            ?disabled=${this.disabled || !this.active}
            @click=${(event: Event) => this.decide(event, decision)}
          >${formatDecision(decision)}</button>`,
        )}</div>
      </article>
    `;
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    if (
      !scopeId ||
      !this.approvalId ||
      !this.active ||
      this.hidden ||
      this.disabled
    ) {
      return emptyActionHintScope();
    }
    const { approvalId, threadId } = this;
    return {
      blocked: false,
      targets: this.actions
        .filter((control) => !control.disabled)
        .map((control) => {
          const decision = control.dataset.decision ?? "";
          return buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:${decision}`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label: control.textContent ?? "",
            control,
            clipRoots: [this, ...clipRoots].filter(Boolean),
            isActionable: () =>
              this.isConnected &&
              this.active &&
              !this.hidden &&
              !this.disabled &&
              isCurrent() &&
              this.threadId === threadId &&
              this.approvalId === approvalId &&
              this.actions.includes(control) &&
              control.dataset.decision === decision &&
              Boolean(this.request.decisions?.includes(decision)) &&
              !control.disabled,
          });
        }),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (!scopeId || !this.approvalId || !this.active || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const { approvalId, threadId } = this;
    const outputs = Array.from(
      this.querySelectorAll<HTMLElement>(
        ":scope > article > .task-approval-content pre",
      ),
    );
    return {
      blocked: false,
      surfaces: outputs.map((scrollport, index) => ({
        id: `${scopeId}:output:${index}`,
        label: scrollport.getAttribute("aria-label") || "Approval details",
        scrollport,
        axes: ["horizontal"],
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          this.active &&
          !this.hidden &&
          isCurrent() &&
          this.threadId === threadId &&
          this.approvalId === approvalId &&
          this.contains(scrollport) &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      })),
      mutationRoots: [this],
      resizeElements: [this, ...outputs],
      scrollRoots: outputs,
    };
  }

  private decide(event: Event, decision: string) {
    event.stopPropagation();
    if (
      !this.isConnected ||
      !this.active ||
      this.hidden ||
      this.disabled ||
      !this.request.decisions?.includes(decision)
    ) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ApprovalIntentDetail>("caffold:task-approval-intent", {
        bubbles: true,
        detail: {
          threadId: this.threadId,
          approvalId: this.approvalId,
          decision,
        },
      }),
    );
  }

  private get actions() {
    return Array.from(
      this.querySelectorAll<HTMLButtonElement>(
        ":scope > article > .task-approval-actions > button",
      ),
    );
  }
}

/**
 * The specifics of one request, in the order a reader checks them: what would
 * run, what it would reach, and where. Every part is optional because requests
 * differ, so this draws what is present rather than switching on a kind.
 */
function approvalDetails(payload: TaskEventPayload) {
  const command = `${payload.command ?? ""}`.trim();
  return [
    toolDetails(payload.tool),
    command
      ? html`<pre
          class="task-approval-command"
          tabindex="0"
          aria-label="Approval command"
        ><code>${command}</code></pre>`
      : nothing,
    payload.networkEndpoint
      ? definitionList(
          [
            {
              label: "Network destination",
              value: `${payload.networkEndpoint}`,
              code: true,
            },
          ],
          "Network request",
        )
      : nothing,
    permissionRows(payload.permissions),
    requestContext(payload),
    reviewerAnswer(payload.reviewed),
  ];
}

function toolDetails(tool: ApprovalTool | null | undefined) {
  if (!tool) {
    return nothing;
  }
  const context: DefinitionRow[] = [
    { label: "Server", value: `${tool.serverName ?? ""}`, code: true },
    ...(tool.appName ? [{ label: "App", value: tool.appName }] : []),
  ];
  const toolArguments = tool.arguments ?? [];
  return html`
    ${definitionList(context, "Tool context")}
    ${
      tool.description
        ? html`<p class="task-approval-reason">${tool.description}</p>`
        : nothing
    }
    ${
      toolArguments.length
        ? html`<dl class="task-approval-arguments" aria-label="Tool arguments">
            ${toolArguments.map((argument) => {
              const value = JSON.stringify(argument.value, null, 2);
              return html`
                <div>
                  <dt>${argument.label}${
                    argument.label !== argument.name
                      ? html` <code>(${argument.name})</code>`
                      : nothing
                  }</dt>
                  <dd><pre
                    tabindex="0"
                    aria-label=${argument.label}
                  ><code>${value}</code></pre></dd>
                </div>
              `;
            })}
          </dl>`
        : nothing
    }
  `;
}

function permissionRows(permissions: TaskEventPayload["permissions"]) {
  if (!Array.isArray(permissions) || !permissions.length) {
    return nothing;
  }
  return definitionList(
    permissions.map((row) => ({
      label: `${row?.label ?? ""}`,
      value: `${row?.value ?? ""}`,
      code: Boolean(row?.verbatim),
    })),
    "Requested permissions",
  );
}

function requestContext(payload: TaskEventPayload) {
  const rows = (
    [
      ["Grant root", payload.grantRoot],
      ["Working directory", payload.cwd],
      ["Environment", payload.environment],
    ] as const
  )
    .filter(([, value]) => `${value ?? ""}`.trim())
    .map(([label, value]) => ({ label, value: `${value}`, code: true }));
  return rows.length ? definitionList(rows, "Request context") : nothing;
}

/**
 * What Caffold's reviewer said about a request it did not answer.
 *
 * Only a request Jev found no reason to ask about leaves the conversation
 * without a card, so every card that names a reviewer names how much reason it
 * found. Seeing that is the only way to tell a request that nearly went through
 * from one nothing spoke for.
 */
function reviewerAnswer(reviewed: TaskEventPayload["reviewed"]) {
  if (!reviewed || typeof reviewed.concern !== "number") {
    return nothing;
  }
  return definitionList(
    [
      {
        label: "Jev",
        value: `${Math.round(reviewed.concern * 100)}% sure this needs you`,
      },
      { label: "Model", value: `${reviewed.model ?? ""}`, code: true },
    ].filter((row) => row.value),
    "Reviewer answer",
  );
}

function definitionList(rows: DefinitionRow[], label: string) {
  return html`
    <dl class="task-approval-details" aria-label=${label}>
      ${rows.map(
        (row) => html`<div>
          <dt>${row.label}</dt>
          <dd>${
            row.code
              ? html`<code>${breakableCode(row.value)}</code>`
              : row.value
          }</dd>
        </div>`,
      )}
    </dl>
  `;
}

// A path or name breaks after each separator rather than anywhere.
function breakableCode(value: string) {
  return value
    .split(/(?<=[/\\])/)
    .map((part, index) => (index ? html`<wbr>${part}` : part));
}

customElements.define("caffold-task-approval", CaffoldTaskApproval);
