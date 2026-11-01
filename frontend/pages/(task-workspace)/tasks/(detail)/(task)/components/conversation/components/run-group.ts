import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
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
import {
  type FinishedRunKind,
  isCommandEvent,
  runGroupIdentity,
} from "../finished-runs.js";
import "./command.js";
import "./tool-call.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldTaskCommand } from "./command.js";
import { runGroupPresentation } from "./run-group/model.js";
import type { CaffoldTaskToolCall } from "./tool-call.js";

import styles from "./run-group.css.js";

const CHEVRON = "task-run-group-chevron-icon";

// Whether each group was left open, by group identity. A group's entry is drawn
// anew when its turn finishes and folds into work details, and when the Task is
// opened again; the group should still be open or closed as the person left it.
const disclosureStateByIdentity = new Map<string, boolean>();

export interface RunGroupDisclosureIntentDetail {
  identity: string;
  open: boolean;
}

// Finished commands or tool calls that ran one after another, folded into one
// entry that opens to a row for each. Each row keeps its element while the
// group grows, so a row someone is looking at or has focused is not drawn
// again under them.
@customElement("caffold-task-run-group")
export class CaffoldTaskRunGroup extends CaffoldElement {
  @property({ attribute: false })
  accessor identity = "";
  @property({ attribute: false })
  accessor runKind: FinishedRunKind = "command";
  @property({ attribute: false, hasChanged: changedEventList })
  accessor events: TaskEvent[] = [];

  static override styles = styles;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly details = new DrawnRef<HTMLDetailsElement>(this);
  private readonly summary = new DrawnRef<HTMLElement>(this);
  private readonly chevron = new DrawnRef<HTMLElement>(this);
  private readonly list = new DrawnRef<HTMLOListElement>(this);
  private readonly rows = new DrawnRefs<
    CaffoldTaskCommand | CaffoldTaskToolCall
  >(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // The summary toggles the native disclosure; drawing again keeps what the
  // person chose.
  override render() {
    const presentation = runGroupPresentation(this.runKind, this.events);
    const open = this.rememberedOpen();
    return html`
      <details
        ${drawn(this.details)}
        class="task-run-group-disclosure"
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
          class="task-run-group-summary"
          @click=${this.toggleDisclosure}
        >
          <span class="task-run-group-label">
            <span
              class="task-run-group-label-text"
            >${presentation.label}</span>
            <span
              ${drawn(this.chevron)}
              class="task-run-group-chevron"
              aria-hidden="true"
            >
              ${inlineIcon(
                "ChevronRight",
                "Collapsed",
                `${CHEVRON} task-run-group-chevron-collapsed`,
              )}
              ${inlineIcon(
                "ChevronDown",
                "Expanded",
                `${CHEVRON} task-run-group-chevron-expanded`,
              )}
            </span>
          </span>
          <span class="task-run-group-results">
            <span
              class="task-run-group-failed"
              ?hidden=${!presentation.failed}
            >${presentation.failed}</span>
            <span
              class="task-run-group-declined"
              ?hidden=${!presentation.declined}
            >${presentation.declined}</span>
          </span>
        </summary>
        <ol ${drawn(this.list)} class="task-run-group-list">${repeat(
          this.events,
          itemKey,
          (event) => {
            const key = itemKey(event);
            if (isCommandEvent(event)) {
              return html`<li
                class="task-run-group-item"
                data-item-key=${key}
              >
                <caffold-task-command
                  ${drawn(this.rows.of(key))}
                  data-command-grouped
                  .event=${event}
                ></caffold-task-command>
              </li>`;
            }
            if (event.type === "tool_call") {
              return html`<li
                class="task-run-group-item"
                data-item-key=${key}
              >
                <caffold-task-tool-call
                  ${drawn(this.rows.of(key))}
                  data-tool-call-grouped
                  .event=${event}
                ></caffold-task-tool-call>
              </li>`;
            }
            // An empty thinking block has nothing to show but when the agent
            // thought.
            const observedMs = taskEventObservedMs(event);
            return html`<li
              class="task-run-group-item task-run-group-thinking"
              data-item-key=${key}
            >
              <div class="task-run-group-thinking-row">
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
    const rowScopes =
      this.disclosure?.open && list
        ? this.events.map((event) => {
            const key = itemKey(event);
            return this.rows.get(key)?.actionHintScope({
              scopeId: `${scopeId}:${this.runKind}:${key}`,
              clipRoots: [this, list, ...clipRoots],
            });
          })
        : [];
    return mergeActionHintScopes(own, ...rowScopes);
  }

  private toggleDisclosure() {
    const disclosure = this.disclosure;
    if (!disclosure) {
      return;
    }
    const open = !disclosure.open;
    disclosureStateByIdentity.set(this.identity, open);
    this.dispatchEvent(
      new CustomEvent<RunGroupDisclosureIntentDetail>(
        "caffold:task-run-group-disclosure-intent",
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
  // its own: the earlier items of a long run can load after the run was
  // opened, which gives the run a new first item.
  private rememberedOpen() {
    const own = disclosureStateByIdentity.get(this.identity);
    if (own !== undefined) {
      return own;
    }
    return this.events
      .filter((event) => event.type !== "reasoning")
      .some(
        (event) =>
          disclosureStateByIdentity.get(
            runGroupIdentity(this.runKind, [event]),
          ) === true,
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-run-group": CaffoldTaskRunGroup;
  }

  interface HTMLElementEventMap {
    "caffold:task-run-group-disclosure-intent": CustomEvent<RunGroupDisclosureIntentDetail>;
  }
}
