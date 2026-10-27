import { html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { eventIdentityKey } from "#tasks/task-events.js";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.js";
import { commandGroupIdentity, isCommandEvent } from "../command-runs.js";
import "./command.js";
import type { CaffoldTaskCommand } from "./command.js";
import { commandGroupPresentation } from "./command-group/model.js";

const CHEVRON = "task-command-group-chevron-icon";

// Whether each group was left open, by group identity. A group's entry is drawn
// anew when its turn finishes and folds into work details, and when the Task is
// opened again; the group should still be open or closed as the person left it.
const disclosureStateByIdentity = new Map<string, boolean>();

export interface CommandGroupDisclosureIntentDetail {
  identity: string;
  open: boolean;
}

// Finished commands that ran one after another, folded into one entry that
// opens to a row for each. Each row keeps its element while the group grows,
// so a row someone is looking at or has focused is not drawn again under them.
export class CaffoldTaskCommandGroup extends LitElement {
  static properties = {
    identity: { attribute: false },
    events: { attribute: false, hasChanged: changedEventList },
  };

  declare identity: string;
  declare events: TaskEvent[];
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly details = new DrawnRef<HTMLDetailsElement>(this);
  private readonly summary = new DrawnRef<HTMLElement>(this);
  private readonly chevron = new DrawnRef<HTMLElement>(this);
  private readonly list = new DrawnRef<HTMLOListElement>(this);
  private readonly commands = new DrawnRefs<CaffoldTaskCommand>(this);

  constructor() {
    super();
    this.identity = "";
    this.events = [];
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

  // The summary toggles the native disclosure; drawing again keeps what the
  // person chose.
  render() {
    const presentation = commandGroupPresentation(this.events);
    const open = this.rememberedOpen();
    return html`
      <details
        ${drawn(this.details)}
        class="task-command-group-disclosure"
        ?open=${open}
        @toggle=${this.followDisclosure}
      >
        <summary
          ${drawn(this.summary)}
          ${this.hints.disclosure({
            id: `disclosure:${encodeURIComponent(this.identity)}`,
            label: `${open ? "Collapse" : "Expand"} ${presentation.label}`,
            action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            anchor: () => this.chevron.value,
            when: Boolean(this.identity),
          })}
          class="task-command-group-summary"
          @click=${this.toggleDisclosure}
        >
          <span class="task-command-group-label">
            <span
              class="task-command-group-label-text"
            >${presentation.label}</span>
            <span
              ${drawn(this.chevron)}
              class="task-command-group-chevron"
              aria-hidden="true"
            >
              ${inlineIcon(
                "ChevronRight",
                "Collapsed",
                `${CHEVRON} task-command-group-chevron-collapsed`,
              )}
              ${inlineIcon(
                "ChevronDown",
                "Expanded",
                `${CHEVRON} task-command-group-chevron-expanded`,
              )}
            </span>
          </span>
          <span class="task-command-group-results">
            <span
              class="task-command-group-failed"
              ?hidden=${!presentation.failed}
            >${presentation.failed}</span>
            <span
              class="task-command-group-declined"
              ?hidden=${!presentation.declined}
            >${presentation.declined}</span>
          </span>
        </summary>
        <ol ${drawn(this.list)} class="task-command-group-list">${repeat(
          this.events,
          itemKey,
          (event) => {
            const key = itemKey(event);
            if (isCommandEvent(event)) {
              return html`<li
                class="task-command-group-item"
                data-item-key=${key}
              >
                <caffold-task-command
                  ${drawn(this.commands.of(key))}
                  data-command-grouped
                  .event=${event}
                ></caffold-task-command>
              </li>`;
            }
            // An empty thinking block has nothing to show but when the agent
            // thought.
            const observedMs = taskEventObservedMs(event);
            return html`<li
              class="task-command-group-item task-command-group-thinking"
              data-item-key=${key}
            >
              <div class="task-command-group-thinking-row">
                <span>Thinking</span>
                <time ?hidden=${observedMs === null}>${
                  observedMs === null ? "" : formatDate(observedMs)
                }</time>
              </div>
            </li>`;
          },
        )}</ol>
      </details>
    `;
  }

  disclosureOpen() {
    return Boolean(this.disclosure?.open);
  }

  disclosureAnchorTop() {
    return this.summary.value?.getBoundingClientRect().top ?? null;
  }

  // Whether one of the entries folded into this group was drawn on its own
  // under this event id before the group formed.
  holdsEvent(eventId: string) {
    return (
      Boolean(eventId) && this.events.some((event) => event.id === eventId)
    );
  }

  // A folded group's rows are not on screen.
  actionHintScope({
    scopeId = "",
    clipRoots = [],
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    const list = this.list.value;
    const commandScopes =
      this.disclosure?.open && list
        ? this.events.map((event) => {
            const key = itemKey(event);
            return this.commands.get(key)?.actionHintScope({
              scopeId: `${scopeId}:command:${key}`,
              clipRoots: [this, list, ...clipRoots],
            });
          })
        : [];
    return mergeActionHintScopes(own, ...commandScopes);
  }

  private toggleDisclosure() {
    const disclosure = this.disclosure;
    if (!disclosure) {
      return;
    }
    const open = !disclosure.open;
    disclosureStateByIdentity.set(this.identity, open);
    this.dispatchEvent(
      new CustomEvent<CommandGroupDisclosureIntentDetail>(
        "caffold:task-command-group-disclosure-intent",
        {
          bubbles: true,
          composed: true,
          detail: { identity: this.identity, open },
        },
      ),
    );
  }

  // The disclosure has opened or closed, so its Action Hint says the other.
  private followDisclosure() {
    this.requestUpdate();
  }

  // A group that took in another keeps that group's state when it has none of
  // its own: the earlier commands of a long run can load after the run was
  // opened, which gives the run a new first command.
  private rememberedOpen() {
    const own = disclosureStateByIdentity.get(this.identity);
    if (own !== undefined) {
      return own;
    }
    return this.events
      .filter(isCommandEvent)
      .some(
        (event) =>
          disclosureStateByIdentity.get(commandGroupIdentity([event])) === true,
      );
  }

  private get disclosure() {
    return this.details.value;
  }
}

function itemKey(event: TaskEvent) {
  return eventIdentityKey(event) || event.id;
}

function changedEventList(next: TaskEvent[], previous?: TaskEvent[]) {
  return (
    !previous ||
    next.length !== previous.length ||
    next.some((event, index) => event !== previous[index])
  );
}

customElements.define("caffold-task-command-group", CaffoldTaskCommandGroup);
