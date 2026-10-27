import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { ApprovalTool, TaskEventPayload } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
  ScrollSurfaces,
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
@customElement("caffold-task-approval")
export class CaffoldTaskApproval extends LitElement {
  @property({ attribute: false })
  accessor threadId = "";
  @property({ attribute: false })
  accessor request: TaskEventPayload = {};
  @property({ attribute: false })
  accessor disabled = false;
  @property({ attribute: false })
  accessor active = true;
  @state()
  accessor errorMessage = "";

  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);

  override createRenderRoot() {
    return this;
  }

  get approvalId() {
    return this.request.approvalId ?? "";
  }

  setError(error: Error | null) {
    this.errorMessage = error?.message ?? "";
  }

  override willUpdate(changed: PropertyValues<this>) {
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

  override render() {
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
        <div class="task-approval-content">${approvalDetails(
          request,
          this.surfaces,
        )}</div>
        <p
          class="task-approval-error"
          role="alert"
          ?hidden=${!this.errorMessage}
        >${this.errorMessage}</p>
        <div class="task-approval-actions">${repeat(
          offered,
          (decision) => decision,
          (decision) => html`<button
            ${this.hints.button({
              id: decision,
              label: formatDecision(decision),
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
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

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.active ? this.surfaces.scope(pull) : emptyScrollSurfaceScope();
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
}

/**
 * The specifics of one request, in the order a reader checks them: what would
 * run, what it would reach, and where. Every part is optional because requests
 * differ, so this draws what is present rather than switching on a kind.
 */
function approvalDetails(payload: TaskEventPayload, surfaces: ScrollSurfaces) {
  const command = `${payload.command ?? ""}`.trim();
  return [
    toolDetails(payload.tool, surfaces),
    command
      ? html`<pre
          ${surfaces.surface({
            id: "command",
            label: () => "Approval command",
            axes: ["horizontal"],
          })}
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

function toolDetails(
  tool: ApprovalTool | null | undefined,
  surfaces: ScrollSurfaces,
) {
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
                    ${surfaces.surface({
                      id: `argument:${encodeURIComponent(argument.name)}`,
                      label: () => argument.label,
                      axes: ["horizontal"],
                    })}
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-approval": CaffoldTaskApproval;
  }
}
