import { html, LitElement, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  disclosureActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
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
} from "../command-runs.ts";
import "./assistant-message.ts";
import type { CaffoldTaskAssistantMessage } from "./assistant-message.ts";
import "./changed-files.ts";
import "./command.ts";
import type { CaffoldTaskCommand } from "./command.ts";
import "./command-group.ts";
import type { CaffoldTaskCommandGroup } from "./command-group.ts";

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
export class CaffoldTaskWorkDetails extends LitElement {
  static properties = {
    identity: { attribute: false },
    label: { attribute: false },
    updateText: { attribute: false },
    events: { attribute: false, hasChanged: changedEventList },
    filePathPresentationBase: { attribute: false },
  };

  declare identity: string;
  declare label: string;
  declare updateText: string;
  declare events: TaskEvent[];
  declare filePathPresentationBase: string;
  private items: WorkItem[] = [];
  private scrollSurfaceRecords: RawScrollSurfaceRecord[] = [];
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.identity = "";
    this.label = "Work details";
    this.updateText = "";
    this.events = [];
    this.filePathPresentationBase = "";
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
    this.rememberDisclosureState();
  }

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("events") || changed.has("filePathPresentationBase")) {
      this.items = workItems(this.events, this.filePathPresentationBase);
    }
  }

  // The summary toggles the native disclosure; drawing again keeps what the
  // person chose.
  render() {
    return html`
      <details
        data-work-details-disclosure-key="root"
        ?open=${this.disclosureState().get("root") ?? false}
      >
        <summary @click=${this.toggleDisclosure}>
          <span class="task-work-details-label">
            <span class="task-work-details-label-text">${this.label}</span>
            <span class="task-work-details-chevron" aria-hidden="true">
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
        <div class="task-work-details-body">${repeat(
          this.items,
          (item) => item.key,
          workItemTemplate,
        )}</div>
      </details>
    `;
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("identity")) {
      this.dataset.workDetailsIdentity = this.identity;
    }
    if (changed.has("events") || changed.has("filePathPresentationBase")) {
      const body = this.querySelector<HTMLElement>(
        ":scope > details > .task-work-details-body",
      );
      this.scrollSurfaceRecords = body ? rawScrollSurfaceRecords(body) : [];
    }
  }

  disclosureOpen(key = "root") {
    return Boolean(this.disclosure(key)?.open);
  }

  disclosureAnchorTop(key = "root") {
    return (
      this.disclosure(key)
        ?.querySelector(":scope > summary")
        ?.getBoundingClientRect().top ?? null
    );
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const disclosureSelector =
      ':scope > details[data-work-details-disclosure-key="root"]';
    const disclosure =
      this.querySelector<HTMLDetailsElement>(disclosureSelector);
    const control = disclosure?.querySelector<HTMLElement>(":scope > summary");
    const anchor = control?.querySelector(
      ":scope > .task-work-details-label > .task-work-details-chevron",
    );
    const body = this.querySelector<HTMLElement>(
      ":scope > details > .task-work-details-body",
    );
    const identity = this.identity;
    if (!scopeId || !body || !identity || this.hidden) {
      return emptyActionHintScope();
    }
    const ownScope: ActionHintScope | null =
      disclosure && control && anchor
        ? {
            blocked: false,
            targets: [
              disclosureActionHintTarget({
                invalidationOwner: this,
                id: `${scopeId}:disclosure:${encodeURIComponent(identity)}:root`,
                actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                label: `${disclosure.open ? "Collapse" : "Expand"} ${
                  this.label.trim() || "Work details"
                }`,
                control,
                anchor,
                clipRoots: [this, ...clipRoots].filter(Boolean),
                isActionable: () =>
                  this.isConnected &&
                  !this.hidden &&
                  this.identity === identity &&
                  this.querySelector(disclosureSelector) === disclosure &&
                  disclosure.querySelector(":scope > summary") === control &&
                  control.querySelector(
                    ":scope > .task-work-details-label > .task-work-details-chevron",
                  ) === anchor,
              }),
            ],
            mutationRoots: [this],
            scrollRoots: [],
          }
        : null;
    const childClipRoots = [this, body, ...clipRoots].filter(Boolean);
    const scopes = Array.from(body.children)
      .flatMap((item) => {
        const commandIdentity =
          item.getAttribute("data-command-work-identity") ?? "";
        const groupIdentity =
          item.getAttribute("data-command-group-work-identity") ?? "";
        const messageIdentity =
          item.getAttribute("data-message-work-identity") ?? "";
        return [
          commandIdentity &&
            item
              .querySelector<CaffoldTaskCommand>(
                ":scope > caffold-task-command",
              )
              ?.actionHintScope({
                scopeId: `${scopeId}:command:${commandIdentity}`,
                clipRoots: childClipRoots,
              }),
          groupIdentity &&
            item
              .querySelector<CaffoldTaskCommandGroup>(
                ":scope > caffold-task-command-group",
              )
              ?.actionHintScope({
                scopeId: `${scopeId}:command-group:${groupIdentity}`,
                clipRoots: childClipRoots,
              }),
          messageIdentity &&
            item
              .querySelector<CaffoldTaskAssistantMessage>(
                ":scope > caffold-task-assistant-message",
              )
              ?.actionHintScope({
                scopeId: `${scopeId}:message:${messageIdentity}`,
                clipRoots: childClipRoots,
              }),
        ];
      })
      .filter((scope): scope is ActionHintScope => Boolean(scope));
    return mergeActionHintScopes(ownScope, ...scopes);
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const disclosure = this.querySelector<HTMLDetailsElement>(
      ':scope > details[data-work-details-disclosure-key="root"]',
    );
    const body = disclosure?.querySelector<HTMLElement>(
      ":scope > .task-work-details-body",
    );
    const identity = this.identity;
    if (!scopeId || !disclosure || !body || !identity || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const current = () =>
      this.isConnected &&
      !this.hidden &&
      isCurrent() &&
      this.identity === identity &&
      this.querySelector(
        ':scope > details[data-work-details-disclosure-key="root"]',
      ) === disclosure &&
      disclosure.open &&
      disclosure.querySelector(":scope > .task-work-details-body") === body;
    const rawScopes = this.scrollSurfaceRecords.map(
      (record): ScrollSurfaceScope => ({
        blocked: false,
        surfaces: [
          {
            id: `${scopeId}:raw:${record.ordinal}`,
            label: record.label,
            scrollport: record.scrollport,
            axes: ["horizontal"],
            clipRoots: [this, body, record.scrollport, ...clipRoots].filter(
              Boolean,
            ),
            isEligible: () =>
              current() &&
              this.scrollSurfaceRecords.includes(record) &&
              body.contains(record.scrollport) &&
              hasScrollLayoutBox(this) &&
              hasScrollLayoutBox(record.scrollport),
          },
        ],
        mutationRoots: [this],
        resizeElements: [this, record.scrollport],
        scrollRoots: [record.scrollport],
      }),
    );
    const childClipRoots = [this, body, ...clipRoots].filter(Boolean);
    const childScopes = Array.from(body.children)
      .flatMap((item) => {
        const commandIdentity =
          item.getAttribute("data-command-work-identity") ?? "";
        const messageIdentity =
          item.getAttribute("data-message-work-identity") ?? "";
        return [
          commandIdentity &&
            item
              .querySelector<CaffoldTaskCommand>(
                ":scope > caffold-task-command",
              )
              ?.scrollSurfaceScope({
                scopeId: `${scopeId}:command:${commandIdentity}`,
                clipRoots: childClipRoots,
                isCurrent: current,
              }),
          messageIdentity &&
            item
              .querySelector<CaffoldTaskAssistantMessage>(
                ":scope > caffold-task-assistant-message",
              )
              ?.scrollSurfaceScope({
                scopeId: `${scopeId}:message:${messageIdentity}`,
                clipRoots: childClipRoots,
                isCurrent: current,
              }),
        ];
      })
      .filter((scope): scope is ScrollSurfaceScope => Boolean(scope));
    return mergeScrollSurfaceScopes(...rawScopes, ...childScopes);
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

  private disclosure(key: string) {
    return Array.from(
      this.querySelectorAll<HTMLDetailsElement>(
        "details[data-work-details-disclosure-key]",
      ),
    ).find((entry) => entry.dataset.workDetailsDisclosureKey === key);
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
    const state = this.disclosureState();
    for (const disclosure of this.querySelectorAll<HTMLDetailsElement>(
      "details[data-work-details-disclosure-key]",
    )) {
      state.set(
        disclosure.dataset.workDetailsDisclosureKey ?? "",
        disclosure.open,
      );
    }
  }
}

interface RawScrollSurfaceRecord {
  scrollport: HTMLElement;
  ordinal: number;
  label: string;
}

function workItemTemplate(item: WorkItem) {
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
      <caffold-task-command .event=${item.event}></caffold-task-command>
    </article>`;
  }
  if (item.kind === "command-group") {
    return html`<article
      class="task-work-details-item task-work-details-command-group"
      data-event-type="command_execution"
      data-command-group-work-identity=${item.identity}
    >
      <caffold-task-command-group
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
      ${item.text ? html`<pre>${item.text}</pre>` : nothing}
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
      ${item.text ? html`<pre>${item.text}</pre>` : nothing}
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

function rawScrollSurfaceRecords(body: HTMLElement): RawScrollSurfaceRecord[] {
  return Array.from(
    body.querySelectorAll<HTMLElement>(
      ":scope > .task-work-details-item > pre",
    ),
  ).map((scrollport, index) => {
    const itemLabel = scrollport.parentElement
      ?.querySelector(":scope > header > strong")
      ?.textContent?.trim();
    return {
      scrollport,
      ordinal: index + 1,
      label: `${itemLabel || "Work details"} output ${index + 1}`,
    };
  });
}

function changedEventList(next: TaskEvent[], previous?: TaskEvent[]) {
  return (
    !previous ||
    next.length !== previous.length ||
    next.some((event, index) => event !== previous[index])
  );
}

customElements.define("caffold-task-work-details", CaffoldTaskWorkDetails);
