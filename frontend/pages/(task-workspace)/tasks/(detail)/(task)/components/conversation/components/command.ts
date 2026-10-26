import { html, LitElement, type PropertyValues } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import type { TaskEvent } from "#app/api.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
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
  private readonly hints = new ActionHints(this, () => this.performUpdate(), {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this, () =>
    this.performUpdate(),
  );
  private readonly details = new DrawnRef<HTMLDetailsElement>(this);
  private readonly summary = new DrawnRef<HTMLElement>(this);
  private readonly chevron = new DrawnRef<HTMLElement>(this);

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
            ${this.hints.button({
              id: "view-output",
              label: "View output",
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
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
      <details
        ${drawn(this.details)}
        class="task-command-active"
        ?open=${this.open}
        @toggle=${this.followDisclosure}
      >
        <summary
          ${drawn(this.summary)}
          ${this.hints.disclosure({
            id: `disclosure:${encodeURIComponent(presentation.commandKey)}`,
            label: `${this.open ? "Collapse" : "Expand"} Command`,
            action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            anchor: () => this.chevron.value,
          })}
          class="task-command-active-summary"
          @click=${this.toggleDisclosure}
        >
          <span class="task-command-active-label">
            <span>Command</span>
            <span
              ${drawn(this.chevron)}
              class="task-command-disclosure-chevron"
              aria-hidden="true"
            >
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
        <pre
          ${this.surfaces.surface({
            id: "output",
            axes: ["horizontal"],
            clipRoots: () => [this, this.details.value],
          })}
          class="task-command-active-output"
        >${activeCommandText(presentation)}</pre>
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
    return this.summary.value?.getBoundingClientRect().top ?? null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  scrollSurfaceScope({
    label = "Command output",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
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

  // The disclosure has opened or closed, so its Action Hint says the other.
  private followDisclosure() {
    this.requestUpdate();
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
    return this.details.value;
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
