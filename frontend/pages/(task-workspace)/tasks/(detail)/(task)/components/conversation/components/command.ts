import { html, LitElement, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  disclosureActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import {
  type CommandPresentation,
  commandPresentation,
} from "./command/model.ts";

const CHEVRON = "task-command-disclosure-chevron-icon";

export interface CommandIntentDetail {
  type: "command-output";
  commandKey: string;
}

export interface CommandDisclosureIntentDetail {
  commandKey: string;
  open: boolean;
}

// One command an agent ran. While it runs, a disclosure shows its live
// output; once it ends, a summary row offers the whole output in a dialog.
// Inside a group of commands the group draws the frame, and the row keeps
// everything else.
export class CaffoldTaskCommand extends LitElement {
  static properties = {
    event: { attribute: false },
  };

  declare event: TaskEvent | null;
  private presentation: CommandPresentation = commandPresentation(null);
  // Whether the person left the running command's output open. The summary
  // toggles the native disclosure; drawing again keeps what they chose.
  private open = false;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.event = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // A different command starts from its own default; the same command keeps
  // the disclosure as it was left.
  willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("event")) {
      return;
    }
    const next = commandPresentation(this.event);
    if (next.commandKey !== this.presentation.commandKey) {
      this.open = next.defaultOpen;
    } else if (this.disclosure) {
      this.open = this.disclosure.open;
    }
    this.presentation = next;
  }

  render() {
    const presentation = this.presentation;
    if (presentation.mode === "terminal") {
      return html`
        <div class="task-command-summary">
          <span
            class="task-command-summary-status"
            data-command-result=${presentation.result}
          >${presentation.statusLabel}</span>
          <code
            class="task-command-summary-label"
          >${presentation.commandLine}</code>
          <span
            class="task-command-summary-meta"
            ?hidden=${!presentation.metadata}
          >${presentation.metadata}</span>
          <button
            type="button"
            class="task-command-summary-action"
            data-command-action="command-output"
            data-command-key=${presentation.commandKey}
            aria-haspopup="dialog"
            @click=${this.requestOutput}
          >View output</button>
        </div>
      `;
    }
    return html`
      <details class="task-command-active" ?open=${this.open}>
        <summary
          class="task-command-active-summary"
          @click=${this.toggleDisclosure}
        >
          <span class="task-command-active-label">
            <span>Command</span>
            <span class="task-command-disclosure-chevron" aria-hidden="true">
              ${inlineIcon(
                "ChevronRight",
                "Collapsed",
                `${CHEVRON} task-command-disclosure-chevron-collapsed`,
              )}
              ${inlineIcon(
                "ChevronDown",
                "Expanded",
                `${CHEVRON} task-command-disclosure-chevron-expanded`,
              )}
            </span>
          </span>
          <span
            class="task-command-active-status"
          >${presentation.statusLabel}</span>
          <time class="task-command-active-time">${presentation.time}</time>
        </summary>
        <pre class="task-command-active-output">${activeCommandText(
          presentation,
        )}</pre>
      </details>
    `;
  }

  updated() {
    const { status, tone, mode } = this.presentation;
    if (this.dataset.commandStatus !== status) {
      this.dataset.commandStatus = status;
    }
    if (this.dataset.commandTone !== tone) {
      this.dataset.commandTone = tone;
    }
    const terminal = mode === "terminal";
    if (this.hasAttribute("data-command-terminal") !== terminal) {
      this.toggleAttribute("data-command-terminal", terminal);
    }
  }

  get commandKey() {
    return this.presentation.commandKey;
  }

  disclosureOpen() {
    return Boolean(this.disclosure?.open);
  }

  disclosureAnchorTop() {
    return (
      this.disclosure
        ?.querySelector(":scope > summary")
        ?.getBoundingClientRect().top ?? null
    );
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const commandKey = this.commandKey;
    if (!scopeId || !commandKey || this.hidden) {
      return emptyActionHintScope();
    }
    if (this.presentation.mode === "active") {
      const disclosure = this.disclosure;
      const control = disclosure?.querySelector<HTMLElement>(
        ":scope > summary.task-command-active-summary",
      );
      const anchor = control?.querySelector(
        ":scope > .task-command-active-label > .task-command-disclosure-chevron",
      );
      if (!disclosure || !control || !anchor) {
        return emptyActionHintScope();
      }
      return {
        blocked: false,
        targets: [
          disclosureActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:disclosure:${encodeURIComponent(commandKey)}`,
            actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            label: `${disclosure.open ? "Collapse" : "Expand"} Command`,
            control,
            anchor,
            clipRoots: [this, ...clipRoots].filter(Boolean),
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              this.commandKey === commandKey &&
              this.presentation.mode === "active" &&
              this.disclosure === disclosure &&
              disclosure.querySelector(
                ":scope > summary.task-command-active-summary",
              ) === control &&
              control.querySelector(
                ":scope > .task-command-active-label > .task-command-disclosure-chevron",
              ) === anchor,
          }),
        ],
        mutationRoots: [this],
        scrollRoots: [],
      };
    }
    const control = this.action;
    if (!control || control.disabled) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:view-output`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") ||
            control.textContent?.trim() ||
            "View output",
          control,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.commandKey === commandKey &&
            this.presentation.mode === "terminal" &&
            this.action === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Command output",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const commandKey = this.commandKey;
    const disclosure = this.disclosure;
    const scrollport = disclosure?.querySelector<HTMLElement>(
      ":scope > .task-command-active-output",
    );
    if (
      !scopeId ||
      !commandKey ||
      this.presentation.mode !== "active" ||
      !disclosure ||
      !scrollport ||
      this.hidden
    ) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:output`,
          label,
          scrollport,
          axes: ["horizontal"],
          clipRoots: [this, disclosure, scrollport, ...clipRoots].filter(
            Boolean,
          ),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.commandKey === commandKey &&
            this.presentation.mode === "active" &&
            this.disclosure === disclosure &&
            disclosure.open &&
            disclosure.querySelector(":scope > .task-command-active-output") ===
              scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private toggleDisclosure() {
    const disclosure = this.disclosure;
    if (!disclosure) {
      return;
    }
    this.open = !disclosure.open;
    this.dispatchEvent(
      new CustomEvent<CommandDisclosureIntentDetail>(
        "caffold:task-command-disclosure-intent",
        {
          bubbles: true,
          composed: true,
          detail: { commandKey: this.commandKey, open: this.open },
        },
      ),
    );
  }

  private requestOutput(event: Event) {
    event.stopPropagation();
    if (!this.commandKey) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<CommandIntentDetail>("caffold:task-command-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "command-output", commandKey: this.commandKey },
      }),
    );
  }

  private get disclosure() {
    return this.querySelector<HTMLDetailsElement>(
      ":scope > details.task-command-active",
    );
  }

  private get action() {
    return this.querySelector<HTMLButtonElement>(
      ":scope > .task-command-summary .task-command-summary-action",
    );
  }
}

function activeCommandText(presentation: CommandPresentation) {
  return [
    `$ ${presentation.command}`,
    presentation.cwd ? `cwd: ${presentation.cwd}` : "",
    presentation.status ? `status: ${presentation.status}` : "",
    presentation.output,
  ]
    .filter(Boolean)
    .join("\n");
}

customElements.define("caffold-task-command", CaffoldTaskCommand);
