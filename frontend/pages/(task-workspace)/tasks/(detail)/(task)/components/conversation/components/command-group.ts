import { html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  disclosureActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import { eventIdentityKey } from "#tasks/task-events.ts";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.ts";
import { commandGroupIdentity, isCommandEvent } from "../command-runs.ts";
import "./command.ts";
import type { CaffoldTaskCommand } from "./command.ts";
import { commandGroupPresentation } from "./command-group/model.ts";

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
    return html`
      <details
        class="task-command-group-disclosure"
        ?open=${this.rememberedOpen()}
      >
        <summary
          class="task-command-group-summary"
          @click=${this.toggleDisclosure}
        >
          <span class="task-command-group-label">
            <span
              class="task-command-group-label-text"
            >${presentation.label}</span>
            <span class="task-command-group-chevron" aria-hidden="true">
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
        <ol class="task-command-group-list">${repeat(
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
    return (
      this.disclosure
        ?.querySelector(":scope > summary")
        ?.getBoundingClientRect().top ?? null
    );
  }

  // Whether one of the entries folded into this group was drawn on its own
  // under this event id before the group formed.
  holdsEvent(eventId: string) {
    return (
      Boolean(eventId) && this.events.some((event) => event.id === eventId)
    );
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const disclosure = this.disclosure;
    const control = disclosure?.querySelector<HTMLElement>(":scope > summary");
    const anchor = control?.querySelector(
      ":scope > .task-command-group-label > .task-command-group-chevron",
    );
    const list = disclosure?.querySelector<HTMLElement>(
      ":scope > .task-command-group-list",
    );
    const identity = this.identity;
    if (
      !scopeId ||
      !disclosure ||
      !control ||
      !anchor ||
      !list ||
      !identity ||
      this.hidden
    ) {
      return emptyActionHintScope();
    }
    const ownScope: ActionHintScope = {
      blocked: false,
      targets: [
        disclosureActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:disclosure:${encodeURIComponent(identity)}`,
          actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          label: `${disclosure.open ? "Collapse" : "Expand"} ${
            commandGroupPresentation(this.events).label
          }`,
          control,
          anchor,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.identity === identity &&
            this.disclosure === disclosure &&
            disclosure.querySelector(":scope > summary") === control &&
            control.querySelector(
              ":scope > .task-command-group-label > .task-command-group-chevron",
            ) === anchor,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
    // Rows of a folded group are not on screen, so only an open group offers
    // its commands' actions.
    const commandScopes = disclosure.open
      ? Array.from(list.children, (item) =>
          item
            .querySelector<CaffoldTaskCommand>(":scope > caffold-task-command")
            ?.actionHintScope({
              scopeId: `${scopeId}:command:${item.getAttribute("data-item-key")}`,
              clipRoots: [this, list, ...clipRoots].filter(Boolean),
            }),
        )
      : [];
    return mergeActionHintScopes(ownScope, ...commandScopes);
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
    return this.querySelector<HTMLDetailsElement>(
      ":scope > details.task-command-group-disclosure",
    );
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
