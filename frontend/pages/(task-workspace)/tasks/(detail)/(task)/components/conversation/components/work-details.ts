import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import {
  eventIdentityKey,
  fileChangePathPresentations,
  sortEventsChronologically,
  taskEventAnchorMs,
  taskEventPositionIndex,
} from "#tasks/task-events.js";
import {
  formatDate,
  formatStatus,
  type TaskFilePath,
  taskEventObservedMs,
  toolCallPresentation,
} from "#tasks/task-format.js";
import {
  commandGroupIdentity,
  groupFinishedCommands,
} from "../command-runs.js";
import "./assistant-message.js";
import type { CaffoldTaskAssistantMessage } from "./assistant-message.js";
import "./changed-files.js";
import "./command.js";
import type { CaffoldTaskCommand } from "./command.js";
import "./command-group.js";
import type { CaffoldTaskCommandGroup } from "./command-group.js";

const CHEVRON = "task-work-details-chevron-icon";

// Which disclosures of each finished turn's work were left open, by work
// identity and disclosure key. The work is drawn anew when its Task is opened
// again; it should still be open or closed as the person left it.
const disclosureStateByIdentity = new Map<string, Map<string, boolean>>();

export interface WorkDetailsDisclosureIntentDetail {
  identity: string;
  key: string;
  open: boolean;
}

// One entry of a finished turn's work, in the order the turn did it.
type WorkItem =
  | { kind: "message"; key: string; identity: string; event: TaskEvent }
  | { kind: "command"; key: string; identity: string; event: TaskEvent }
  | {
      kind: "command-group";
      key: string;
      identity: string;
      events: TaskEvent[];
    }
  | {
      kind: "file-change";
      key: string;
      identity: string;
      event: TaskEvent;
      text: string;
      files: TaskFilePath[];
    }
  | {
      kind: "shell";
      key: string;
      event: TaskEvent;
      label: string;
      text: string;
      tone: "danger" | "neutral";
    }
  | { kind: "other"; key: string; event: TaskEvent };

// A finished turn's work, folded behind one disclosure that says how long the
// turn worked and how many updates it made.
@customElement("caffold-task-work-details")
export class CaffoldTaskWorkDetails extends LitElement {
  @property({ attribute: false })
  accessor identity = "";
  @property({ attribute: false })
  accessor label = "Work details";
  @property({ attribute: false })
  accessor updateText = "";
  @property({ attribute: false, hasChanged: changedEventList })
  accessor events: TaskEvent[] = [];
  @property({ attribute: false })
  accessor filePathPresentationBase = "";

  private items: WorkItem[] = [];
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly details = new DrawnRef<HTMLDetailsElement>(this);
  private readonly summary = new DrawnRef<HTMLElement>(this);
  private readonly chevron = new DrawnRef<HTMLElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  // Each item's command, command group, or message, by kind and identity.
  private readonly parts = new DrawnRefs<WorkItemPart>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.rememberDisclosureState();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("events") || changed.has("filePathPresentationBase")) {
      this.items = workItems(this.events, this.filePathPresentationBase);
    }
  }

  // The summary toggles the native disclosure; drawing again keeps what the
  // person chose.
  override render() {
    const open = this.disclosureState().get("root") ?? false;
    const outputs = outputOrdinals(this.items);
    const parts = {
      parts: this.parts,
      surfaces: this.surfaces,
      clipRoots: () => [this, this.body.value],
    };
    return html`
      <details
        ${drawn(this.details)}
        data-work-details-disclosure-key="root"
        ?open=${open}
        @toggle=${this.followDisclosure}
      >
        <summary
          ${drawn(this.summary)}
          ${this.hints.disclosure({
            id: `disclosure:${encodeURIComponent(this.identity)}:root`,
            label: `${open ? "Collapse" : "Expand"} ${
              this.label.trim() || "Work details"
            }`,
            action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            anchor: () => this.chevron.value,
            when: Boolean(this.identity),
          })}
          @click=${this.toggleDisclosure}
        >
          <span class="task-work-details-label">
            <span class="task-work-details-label-text">${this.label}</span>
            <span
              ${drawn(this.chevron)}
              class="task-work-details-chevron"
              aria-hidden="true"
            >
              ${inlineIcon(
                "ChevronRight",
                "Collapsed",
                `${CHEVRON} task-work-details-chevron-collapsed`,
              )}
              ${inlineIcon(
                "ChevronDown",
                "Expanded",
                `${CHEVRON} task-work-details-chevron-expanded`,
              )}
            </span>
          </span>
          <span class="task-work-details-count">${this.updateText}</span>
        </summary>
        <div ${drawn(this.body)} class="task-work-details-body">${repeat(
          this.items,
          (item) => item.key,
          (item) => workItemTemplate(item, outputs.get(item.key) ?? 0, parts),
        )}</div>
      </details>
    `;
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("identity")) {
      this.dataset.workDetailsIdentity = this.identity;
    }
  }

  disclosureOpen(key = "root") {
    return Boolean(this.disclosure(key)?.open);
  }

  disclosureAnchorTop(key = "root") {
    return key === "root"
      ? (this.summary.value?.getBoundingClientRect().top ?? null)
      : null;
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    const body = this.body.value;
    if (!body) {
      return emptyActionHintScope();
    }
    const childClipRoots = [this, body, ...clipRoots];
    return mergeActionHintScopes(
      own,
      ...this.items.map((item) =>
        "identity" in item
          ? this.parts.get(`${item.kind}:${item.identity}`)?.actionHintScope({
              scopeId: `${scopeId}:${item.kind}:${item.identity}`,
              clipRoots: childClipRoots,
            })
          : null,
      ),
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
    ...pull
  }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, scopeId, clipRoots });
    const body = this.body.value;
    if (!body || !this.details.value?.open) {
      return emptyScrollSurfaceScope();
    }
    const childClipRoots = [this, body, ...clipRoots];
    return mergeScrollSurfaceScopes(
      own,
      ...this.items.map((item) =>
        item.kind === "command" || item.kind === "message"
          ? (
              this.parts.get(`${item.kind}:${item.identity}`) as
                | CaffoldTaskCommand
                | CaffoldTaskAssistantMessage
                | undefined
            )?.scrollSurfaceScope({
              scopeId: `${scopeId}:${item.kind}:${item.identity}`,
              clipRoots: childClipRoots,
            })
          : null,
      ),
    );
  }

  private toggleDisclosure(event: Event) {
    const summary = event.currentTarget;
    const disclosure =
      summary instanceof Element ? summary.parentElement : null;
    if (!(disclosure instanceof HTMLDetailsElement)) {
      return;
    }
    const key = disclosure.dataset.workDetailsDisclosureKey ?? "";
    const open = !disclosure.open;
    this.disclosureState().set(key, open);
    this.dispatchEvent(
      new CustomEvent<WorkDetailsDisclosureIntentDetail>(
        "caffold:task-work-details-disclosure-intent",
        {
          bubbles: true,
          composed: true,
          detail: { identity: this.identity, key, open },
        },
      ),
    );
  }

  // The disclosure has opened or closed, so its Action Hint says the other.
  private followDisclosure() {
    this.requestUpdate();
  }

  private disclosure(key: string) {
    return key === "root" ? this.details.value : undefined;
  }

  private disclosureState() {
    const identity = this.identity;
    if (!identity) {
      return new Map<string, boolean>();
    }
    let state = disclosureStateByIdentity.get(identity);
    if (!state) {
      state = new Map();
      disclosureStateByIdentity.set(identity, state);
    }
    return state;
  }

  private rememberDisclosureState() {
    if (!this.hasUpdated || !this.identity) {
      return;
    }
    const disclosure = this.details.value;
    if (disclosure) {
      this.disclosureState().set("root", disclosure.open);
    }
  }
}

type WorkItemPart =
  | CaffoldTaskCommand
  | CaffoldTaskCommandGroup
  | CaffoldTaskAssistantMessage;

// Where an item's parts are kept and how its printed output scrolls.
interface WorkItemParts {
  parts: DrawnRefs<WorkItemPart>;
  surfaces: ScrollSurfaces;
  clipRoots: () => Array<Element | undefined>;
}

// The place of each item's printed output among all of the turn's, which its
// Scroll surface is numbered by.
function outputOrdinals(items: WorkItem[]) {
  const ordinals = new Map<string, number>();
  for (const item of items) {
    if ((item.kind === "file-change" || item.kind === "shell") && item.text) {
      ordinals.set(item.key, ordinals.size + 1);
    }
  }
  return ordinals;
}

function workItemTemplate(
  item: WorkItem,
  output: number,
  { parts, surfaces, clipRoots }: WorkItemParts,
) {
  const printed = (label: string, text: string) =>
    text
      ? html`<pre
          ${surfaces.surface({
            id: `raw:${output}`,
            label: () => `${label || "Work details"} output ${output}`,
            axes: ["horizontal"],
            clipRoots,
          })}
        >${text}</pre>`
      : nothing;
  if (item.kind === "message") {
    // A message the agent wrote reads as prose wherever it appears, so a
    // folded turn mounts the same component the conversation shows inline.
    // Only the placement differs.
    return html`<article
      class="task-work-details-item task-work-details-message"
      data-event-type="assistant_message"
      data-message-work-identity=${item.identity}
    >
      <caffold-task-assistant-message
        ${drawn(parts.of(`message:${item.identity}`))}
        .event=${item.event}
      ></caffold-task-assistant-message>
    </article>`;
  }
  if (item.kind === "command") {
    return html`<article
      class="task-work-details-item task-work-details-command"
      data-event-type="command_execution"
      data-command-work-identity=${item.identity}
    >
      <caffold-task-command
        ${drawn(parts.of(`command:${item.identity}`))}
        .event=${item.event}
      ></caffold-task-command>
    </article>`;
  }
  if (item.kind === "command-group") {
    return html`<article
      class="task-work-details-item task-work-details-command-group"
      data-event-type="command_execution"
      data-command-group-work-identity=${item.identity}
    >
      <caffold-task-command-group
        ${drawn(parts.of(`command-group:${item.identity}`))}
        .identity=${item.identity}
        .events=${item.events}
      ></caffold-task-command-group>
    </article>`;
  }
  if (item.kind === "file-change") {
    return html`<article
      class="task-work-details-item"
      data-event-type="file_change"
      data-tool-tone="neutral"
      data-file-change-work-identity=${item.identity}
    >
      <header>
        <strong>Files changed</strong>
        ${observedTime(item.event)}
      </header>
      ${printed("Files changed", item.text)}
      <caffold-task-changed-files
        .files=${item.files}
      ></caffold-task-changed-files>
    </article>`;
  }
  if (item.kind === "shell") {
    return html`<article
      class="task-work-details-item"
      data-event-type=${item.event.type}
      data-tool-tone=${item.tone}
    >
      <header>
        <strong>${item.label}</strong>
        ${observedTime(item.event)}
      </header>
      ${printed(item.label, item.text)}
    </article>`;
  }
  return html`<article
    class="task-work-details-item"
    data-event-type=${item.event.type}
  >
    <header>
      <strong>${item.event.summary}</strong>
      ${observedTime(item.event)}
    </header>
  </article>`;
}

function observedTime(event: TaskEvent) {
  const observedMs = taskEventObservedMs(event);
  return observedMs === null
    ? nothing
    : html`<time>${formatDate(observedMs)}</time>`;
}

// Thinking and file changes in a row read as one entry each; other work
// keeps an entry of its own.
function workItems(events: TaskEvent[], filePathPresentationBase: string) {
  const items: WorkItem[] = [];
  let combinedEvents: TaskEvent[] = [];
  let combinedType = "";
  const shell = (
    event: TaskEvent,
    label: string,
    text: string | undefined,
    tone: "danger" | "neutral" = "neutral",
  ) => {
    items.push({
      kind: "shell",
      key: `#${items.length}`,
      event,
      label,
      text: `${text ?? ""}`.trim(),
      tone,
    });
  };
  const fileChange = (
    fileChanges: TaskEvent[],
    latest: TaskEvent,
    text: string,
  ) => {
    const identity = fileChangeWorkIdentity(fileChanges);
    items.push({
      kind: "file-change",
      key: identity,
      identity,
      event: latest,
      text: text.trim(),
      files: fileChangePathPresentations(fileChanges, filePathPresentationBase),
    });
  };
  const flushCombinedEvents = () => {
    const latest = sortEventsChronologically(combinedEvents).at(-1);
    if (combinedType === "reasoning" && latest) {
      shell(
        latest,
        "Thinking",
        combinedEvents.map(reasoningText).filter(Boolean).join("\n\n"),
      );
    } else if (combinedType === "file_change" && latest) {
      fileChange(
        combinedEvents,
        latest,
        combinedFileChangeText(combinedEvents, latest),
      );
    }
    combinedEvents = [];
    combinedType = "";
  };

  for (const segment of groupFinishedCommands(events)) {
    if (segment.group) {
      flushCombinedEvents();
      const identity = commandGroupIdentity(segment.group);
      items.push({
        kind: "command-group",
        key: identity,
        identity,
        events: segment.group,
      });
      continue;
    }
    const { event } = segment;
    if (event.type === "reasoning" || event.type === "file_change") {
      if (combinedType && combinedType !== event.type) {
        flushCombinedEvents();
      }
      combinedType = event.type;
      combinedEvents.push(event);
      continue;
    }
    flushCombinedEvents();
    const payload = event.payload ?? {};
    const identity = eventIdentityKey(event) || event.id;
    if (event.type === "assistant_message") {
      items.push({
        kind: "message",
        key: `message:${identity}`,
        identity,
        event,
      });
    } else if (event.type === "command_execution") {
      items.push({
        kind: "command",
        key: `command:${identity}`,
        identity,
        event,
      });
    } else if (event.type === "plan") {
      shell(event, "Plan", payload.text);
    } else if (event.type === "tool_call") {
      const tool = toolCallPresentation(payload);
      shell(event, tool.label, tool.text, tool.tone);
    } else if (event.type === "task_failed") {
      shell(event, "Error", event.summary, "danger");
    } else {
      items.push({ kind: "other", key: `#${items.length}`, event });
    }
  }
  flushCombinedEvents();
  return items;
}

function reasoningText(event: TaskEvent) {
  const payload = event.payload ?? {};
  const summary = Array.isArray(payload.summary)
    ? payload.summary.filter(Boolean).join("\n\n")
    : "";
  const content = Array.isArray(payload.content)
    ? payload.content.filter(Boolean).join("\n\n")
    : "";
  return [summary, content].filter(Boolean).join("\n\n");
}

function combinedFileChangeText(events: TaskEvent[], latest: TaskEvent) {
  const payload = latest.payload ?? {};
  const latestCount = Array.isArray(payload.paths)
    ? payload.paths.length
    : null;
  const latestSummary =
    typeof latestCount === "number"
      ? latestCount === 1
        ? "Latest: 1 changed file"
        : `Latest: ${latestCount} changed files`
      : "";
  const status = payload.status
    ? `Latest status: ${formatStatus(payload.status)}`
    : "";
  const updateText =
    events.length === 1
      ? "1 file change update"
      : `${events.length} file change updates`;
  return [updateText, latestSummary, status].filter(Boolean).join("\n");
}

function fileChangeWorkIdentity(events: TaskEvent[]) {
  const first = events[0];
  return `file-change:${
    eventIdentityKey(first) ||
    [
      first.threadId,
      taskEventAnchorMs(first),
      taskEventPositionIndex(first),
    ].join(":")
  }`;
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
    "caffold-task-work-details": CaffoldTaskWorkDetails;
  }

  interface HTMLElementEventMap {
    "caffold:task-work-details-disclosure-intent": CustomEvent<WorkDetailsDisclosureIntentDetail>;
  }
}
