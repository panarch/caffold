import { escapeHtml } from "../../../../../../components/dom.js";
import { renderInlineIcon } from "../../../../../../components/icons.js";
import {
  PROMPT_SUBMISSION_STATE,
  isTaskActivelyWorking,
  promptSubmissionState,
  taskActiveFlagLabel,
} from "../../../runtime-state.js";
import {
  assistantMessagePhase,
  canAcceptTurnContinuation,
  conversationGroups,
  dedupeCanonicalEvents,
  eventIdentityKey,
  eventTurnId,
  fileChangePaths,
  isFinalAssistantEvent,
  isImplicitTurnEvent,
  isTerminalTurnEvent,
  isTurnContinuationEvent,
  isTurnStatusEvent,
  isWorkEvent,
  sortEventsChronologically,
} from "../../../task-events.js";
import {
  formatCommand,
  formatDate,
  formatDecision,
  formatDuration,
  formatStatus,
} from "../../../task-format.js";

export function renderConversation(events, task, approvals = [], options = {}) {
  const workDetails = new Map();
  const conversationEvents = sortEventsChronologically(
    dedupeCanonicalEvents(events),
  );
  const groups = conversationGroups(conversationEvents);
  const liveStatusAvailable = !options.controlsDisabled;
  const activeGroupIndex = liveStatusAvailable
    ? activeTurnGroupIndex(groups, task)
    : -1;
  const eventOrder = new Map(
    conversationEvents.map((event, index) => [event, index]),
  );
  const pendingApprovalIds = new Set(
    approvals.map((event) => event.payload?.approvalId).filter(Boolean),
  );
  const userPrompts = new Set(
    conversationEvents
      .filter((event) => event.type === "user_message")
      .map((event) => `${event.payload?.text ?? event.payload?.prompt ?? ""}`.trim())
      .filter(Boolean),
  );
  const entries = groups
    .flatMap((group, index) => {
      if (group.kind === "turn") {
        return renderTurnGroupEntries(group, task, {
          forceActive: index === activeGroupIndex,
          pendingApprovalIds,
          controlsDisabled: options.controlsDisabled,
          approvalErrors: options.approvalErrors,
          liveStatusAvailable,
          eventOrder,
          workDetails,
        });
      }
      if (
        group.event.type === "approval_requested" &&
        pendingApprovalIds.has(group.event.payload?.approvalId)
      ) {
        return [
          renderedTimelineEntry(
            [group.event],
            renderApprovalFlow([group.event], {
              disabled: options.controlsDisabled,
              approvalErrors: options.approvalErrors,
            }),
            eventOrder,
          ),
        ];
      }
      if (!shouldRenderStandaloneEvent(group.event, userPrompts)) {
        return [];
      }
      return [
        renderedTimelineEntry(
          [group.event],
          renderConversationEvent(group.event, task, { active: false }),
          eventOrder,
        ),
      ];
    })
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.order - right.order || left.index - right.index);
  let html = entries.map((entry) => entry.html).join("");
  if (liveStatusAvailable && isTaskActivelyWorking(task)) {
    const activeGroup = groups[activeGroupIndex];
    html += renderActiveTurnStatus(
      activeGroup ?? {
        turnId: task?.activeTurn?.id ?? "active-turn",
        events: [],
      },
      task,
    );
  }
  return { html, workDetails };
}

function renderedTimelineEntry(events, html, eventOrder) {
  if (!html) {
    return null;
  }
  const order = events.reduce(
    (earliest, event) => Math.min(earliest, eventOrder.get(event) ?? earliest),
    Number.MAX_SAFE_INTEGER,
  );
  return { order, html };
}

function activeTurnGroupIndex(groups, task) {
  if (!isTaskActivelyWorking(task)) {
    return -1;
  }
  const exactIndex = groups.findIndex(
    (group) => group.kind === "turn" && group.turnId === task?.activeTurn?.id,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const startedMs = Number(task?.activeTurn?.startedAtMs);
  if (!Number.isFinite(startedMs) || startedMs <= 0) {
    return -1;
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.kind !== "turn") {
      continue;
    }
    const hasCurrentEvent = group.events.some(
      (event) => Number(event.createdMs) >= startedMs - 2_000,
    );
    if (hasCurrentEvent) {
      return index;
    }
  }
  return groups.findLastIndex((group) => group.kind === "turn");
}

function renderTurnGroupEntries(group, task, options = {}) {
  const assistantEvents = group.events.filter((event) => event.type === "assistant_message");
  const statusEvents = group.events.filter(isTurnStatusEvent);
  const terminalEvent = statusEvents.find(isTerminalTurnEvent);
  const finalAssistantEvent =
    assistantEvents.findLast(isFinalAssistantEvent) ?? assistantEvents.at(-1);
  const isCurrentTurn = task?.activeTurn?.id === group.turnId;
  const isActive =
    options.liveStatusAvailable !== false &&
    isTaskActivelyWorking(task) &&
    (options.forceActive || isCurrentTurn);
  const isComplete =
    Boolean(terminalEvent) ||
    (Boolean(finalAssistantEvent && isFinalAssistantEvent(finalAssistantEvent)) &&
      !isActive);

  if (isComplete) {
    return renderCompletedTurnGroupEntries(
      group,
      task,
      terminalEvent,
      finalAssistantEvent,
      options.pendingApprovalIds,
      options.controlsDisabled,
      options.approvalErrors,
      options.eventOrder,
      options.workDetails,
    );
  }

  return group.events
    .map((event) =>
      renderedTimelineEntry(
        [event],
        renderActiveTurnTimelineEvent(
          event,
          task,
          options.pendingApprovalIds,
          options.controlsDisabled,
          options.approvalErrors,
        ),
        options.eventOrder,
      ),
    )
    .filter(Boolean);
}

function renderCompletedTurnGroupEntries(
  group,
  task,
  terminalEvent,
  finalAssistantEvent,
  pendingApprovalIds = new Set(),
  controlsDisabled = false,
  approvalErrors = new Map(),
  eventOrder = new Map(),
  workDetails = new Map(),
) {
  const output = [];
  const userEvents = group.events.filter((event) => event.type === "user_message");
  const workEvents = group.events.filter(
    (event) =>
      isWorkEvent(event) ||
      (event.type === "assistant_message" && event !== finalAssistantEvent),
  );
  const generatedImages = group.events.filter(
    (event) => event.type === "generated_image",
  );
  const approvals = group.events.filter(
    (event) =>
      event.type === "approval_requested" &&
      pendingApprovalIds.has(event.payload?.approvalId),
  );

  for (const event of userEvents) {
    output.push(
      renderedTimelineEntry(
        [event],
        renderConversationEvent(event, task, { active: false }),
        eventOrder,
      ),
    );
  }
  if (workEvents.length > 0) {
    const workSummaryAnchor = workEvents.at(-1);
    output.push(
      renderedTimelineEntry(
        [workSummaryAnchor],
        renderTurnWorkSummary(group, workEvents, terminalEvent, task, workDetails),
        eventOrder,
      ),
    );
  }
  for (const event of generatedImages) {
    output.push(
      renderedTimelineEntry(
        [event],
        renderConversationEvent(event, task, { active: false }),
        eventOrder,
      ),
    );
  }
  if (approvals.length > 0) {
    output.push(
      renderedTimelineEntry(
        approvals,
        renderApprovalFlow(approvals, {
          disabled: controlsDisabled,
          approvalErrors,
        }),
        eventOrder,
      ),
    );
  }
  if (finalAssistantEvent) {
    output.push(
      renderedTimelineEntry(
        [finalAssistantEvent],
        renderConversationEvent(finalAssistantEvent, task, {
          active: false,
          messagePhase: "final",
        }),
        eventOrder,
      ),
    );
  }
  return output.filter(Boolean);
}

function renderActiveTurnTimelineEvent(
  event,
  task,
  pendingApprovalIds = new Set(),
  controlsDisabled = false,
  approvalErrors = new Map(),
) {
  if (
    event.type === "approval_requested" &&
    pendingApprovalIds.has(event.payload?.approvalId)
  ) {
    return renderApprovalFlow([event], {
      disabled: controlsDisabled,
      approvalErrors,
    });
  }
  if (
    event.type === "user_message" ||
    event.type === "assistant_message" ||
    event.type === "generated_image" ||
    isWorkEvent(event)
  ) {
    return renderConversationEvent(event, task, {
      active: isWorkEvent(event),
    });
  }
  return "";
}

function renderActiveTurnStatus(group, task) {
  const startedMs = activeTurnStartMs(task);
  const state = activeTurnStateLabel(group.events, task);
  const threadId = `${task?.threadId ?? task?.id ?? ""}`.trim();
  const turnId = `${group.turnId ?? task?.activeTurn?.id ?? "active-turn"}`;
  const identity = `active-turn:${threadId}:${turnId}`;
  const startedAttribute = startedMs
    ? ` data-active-turn-started-ms="${escapeHtml(startedMs)}"`
    : "";
  const duration = startedMs
    ? `Working for ${formatDuration(Date.now() - startedMs)}`
    : "Working";
  return `
    <li
      class="task-event task-turn-active"
      ${startedAttribute}
      data-turn-id="${escapeHtml(turnId)}"
      data-conversation-entry-key="${escapeHtml(identity)}"
    >
      <span class="task-status-spinner" aria-hidden="true"></span>
      <span class="task-turn-active-duration">${escapeHtml(duration)}</span>
      <span class="task-turn-active-state" title="${escapeHtml(state)}" aria-live="polite">${escapeHtml(state)}</span>
    </li>
  `;
}

function activeTurnStartMs(task) {
  const taskStartedMs = Number(task?.activeTurn?.startedAtMs);
  if (Number.isFinite(taskStartedMs) && taskStartedMs > 0) {
    return taskStartedMs;
  }
  return null;
}

function activeTurnStateLabel(events, task) {
  const activeFlagLabel = taskActiveFlagLabel(task);
  if (activeFlagLabel) {
    return activeFlagLabel;
  }

  const event =
    [...events]
      .reverse()
      .find((entry) => entry.payload?.lifecycle === "started") ??
    [...events]
      .reverse()
      .find((entry) =>
        entry.type === "work_status" ||
        entry.type === "reasoning" ||
        entry.type === "plan" ||
        entry.type === "command_execution" ||
        entry.type === "file_change" ||
        entry.type === "assistant_message",
      );
  if (!event) {
    return "Thinking";
  }
  if (event.type === "work_status") {
    return activeWorkItemLabel(event.payload?.itemType);
  }
  if (event.type === "reasoning") {
    return "Thinking";
  }
  if (event.type === "plan") {
    return "Updating plan";
  }
  if (event.type === "command_execution") {
    return "Running command";
  }
  if (event.type === "file_change") {
    return "Editing files";
  }
  return "Thinking";
}

function activeWorkItemLabel(itemType) {
  if (itemType === "plan") {
    return "Updating plan";
  }
  if (["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(itemType)) {
    return "Running command";
  }
  if (itemType === "fileChange") {
    return "Editing files";
  }
  return "Thinking";
}

function renderApprovalFlow(approvals, options = {}) {
  if (!approvals.length) {
    return "";
  }
  return `
    <li class="task-event task-approval-flow">
      <section class="task-approvals" aria-label="Pending approvals">
        ${approvals
          .map((approval) => renderApprovalCard(approval, options))
          .join("")}
      </section>
    </li>
  `;
}

function shouldRenderStandaloneEvent(event, userPrompts) {
  if (event.type === "prompt_sent") {
    const prompt = `${event.payload?.prompt ?? event.payload?.text ?? ""}`.trim();
    return Boolean(prompt && !userPrompts.has(prompt));
  }
  return ![
    "thread_started",
    "turn_started",
    "turn_completed",
    "thread_status_changed",
    "approval_requested",
    "approval_resolved",
    "diff_updated",
    "work_status",
  ].includes(event.type);
}

export function renderConversationEvent(event, task, eventState) {
  const payload = event.payload ?? {};
  if (event.type === "prompt_sent" || event.type === "user_message") {
    if (event.type === "prompt_sent") {
      return renderStatusEvent(event);
    }
    const message = userMessagePresentation(payload);
    return renderMessageEvent(event, "user", message.text, {
      attachments: message.attachments,
    });
  }
  if (event.type === "assistant_message") {
    return renderMessageEvent(event, "assistant", payload.text, {
      phase: eventState?.messagePhase ?? assistantMessagePhase(payload.phase),
    });
  }
  if (event.type === "generated_image") {
    return renderMessageEvent(event, "assistant", "", {
      attachments: [generatedImagePresentation(event)],
    });
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderThinkingEvent(
      event,
      [summary, content].filter(Boolean).join("\n\n"),
      task,
      eventState,
    );
  }
  if (event.type === "plan") {
    return renderToolEvent(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return renderCommandEvent(event);
  }
  if (event.type === "file_change") {
    return renderFileChangeEvent(event);
  }
  if (event.type === "task_failed") {
    return renderToolEvent(event, "Error", event.summary, "danger");
  }
  return renderStatusEvent(event);
}

function renderStatusEvent(event) {
  const status = statusTone(event.type);
  return `
    <li class="task-event task-event-status"${eventIdentityAttribute(event)} data-event-type="${escapeHtml(event.type)}" data-event-status="${escapeHtml(status)}">
      <span class="task-status-chip">${escapeHtml(event.summary)}</span>
      <time>${escapeHtml(formatDate(event.createdMs))}</time>
    </li>
  `;
}

function renderMessageEvent(event, role, text, options = {}) {
  const value = `${text ?? ""}`.trim();
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (!value && !attachments.length) {
    return renderStatusEvent(event);
  }
  const phaseAttribute = options.phase
    ? ` data-message-phase="${escapeHtml(options.phase)}"`
    : "";
  const attachmentsAttribute = attachments.length ? " data-has-attachments" : "";
  const submissionState = promptSubmissionState(event);
  const deliveryAttribute = submissionState
    ? ` data-delivery-state="${escapeHtml(submissionState)}"`
    : "";
  const deliveryLabel = {
    [PROMPT_SUBMISSION_STATE.SENDING]: "Sending...",
    [PROMPT_SUBMISSION_STATE.ACCEPTED]: "Accepted - syncing...",
    [PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN]: "Delivery unconfirmed",
  }[submissionState] ?? "";

  return `
    <li class="task-event task-message"${eventIdentityAttribute(event)} data-event-type="${escapeHtml(event.type)}" data-message-role="${escapeHtml(role)}"${phaseAttribute}${attachmentsAttribute}${deliveryAttribute}>
      <div class="task-message-header">
        ${deliveryLabel ? `<span class="task-message-delivery">${escapeHtml(deliveryLabel)}</span>` : ""}
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </div>
      ${renderMessageAttachments(attachments)}
      ${value ? `
        <div class="task-message-content">
          <caffold-task-markdown>${escapeHtml(value)}</caffold-task-markdown>
        </div>
      ` : ""}
    </li>
  `;
}

function eventIdentityAttribute(event) {
  const eventId = `${event?.id ?? ""}`.trim();
  return eventId ? ` data-event-id="${escapeHtml(eventId)}"` : "";
}

function disclosureIdentityAttribute(kind, identity) {
  const value = `${identity ?? ""}`.trim();
  return value
    ? ` data-disclosure-key="${escapeHtml(`${kind}:${value}`)}"`
    : "";
}

function turnGroupDisclosureIdentity(group) {
  const turnId = `${group?.turnId ?? ""}`.trim();
  if (turnId && !turnId.startsWith("implicit-")) {
    return turnId;
  }

  const eventId = group?.events
    ?.map((event) => `${event?.id ?? ""}`.trim())
    .find(Boolean);
  return eventId || eventIdentityKey(group?.events?.[0]) || turnId;
}

function userMessagePresentation(payload) {
  const content = userMessageContent(payload);
  const text = userMessageText(payload);
  const imageItems = content.filter((item) => ["image", "localImage"].includes(item?.type));

  if (!imageItems.length) {
    return { text, attachments: [] };
  }

  const parsed = parseCodexAttachmentPrompt(text);
  const names = parsed?.fileNames ?? [];
  return {
    text: parsed?.request ?? text,
    attachments: imageItems.map((item, index) => ({
      src: taskImageSource(item),
      name: item.name ?? names[index] ?? `Attached image ${index + 1}`,
    })),
  };
}

function generatedImagePresentation(event) {
  const payload = event?.payload ?? {};
  const threadId = `${event?.threadId ?? payload.threadId ?? ""}`.trim();
  const itemId = `${payload.itemId ?? ""}`.trim();
  const src =
    threadId && itemId
      ? `/api/tasks/${encodeURIComponent(threadId)}/generated-images/${encodeURIComponent(itemId)}`
      : "";
  return {
    src,
    name: `${payload.name ?? "Generated image.png"}`.trim(),
  };
}

function userMessageText(payload) {
  const prompt = `${payload?.prompt ?? ""}`.trim();
  const payloadText = `${payload?.text ?? ""}`.trim();
  const content = userMessageContent(payload);
  const itemText = content
    .filter((item) => ["text", "input_text"].includes(item?.type))
    .map((item) => `${item?.text ?? ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  return normalizedUserMessageText(payloadText || prompt || itemText);
}

function userMessageContent(payload) {
  if (Array.isArray(payload?.content)) {
    return payload.content;
  }
  return Array.isArray(payload?.item?.content) ? payload.item.content : [];
}

function normalizedUserMessageText(text) {
  const isAmbientWrapper =
    text.includes("automatically supplied ambient UI state") ||
    text.includes("<in-app-browser-context") ||
    text.includes("# In app browser:");
  if (!isAmbientWrapper) {
    return text;
  }

  for (const marker of ["## My request for Codex:", "My request for Codex:"]) {
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return text.slice(markerIndex + marker.length).trim();
    }
  }
  return text;
}

function taskImageSource(item) {
  if (item?.type === "image") {
    return safeTaskImageSource(item.url);
  }
  if (item?.type !== "localImage") {
    return "";
  }
  const path = `${item.path ?? ""}`.trim();
  if (!path.startsWith("/")) {
    return "";
  }
  return `/api/task-image?${new URLSearchParams({ path })}`;
}

function safeTaskImageSource(value) {
  const source = `${value ?? ""}`.trim();
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(source)
    ? source
    : "";
}

function parseCodexAttachmentPrompt(text) {
  const filesMarker = /^# Files mentioned by the user:\s*$/m;
  const requestMarker = /^## My request for Codex:\s*$/m;
  const filesMatch = filesMarker.exec(text);
  const requestMatch = requestMarker.exec(text);
  if (!filesMatch || !requestMatch || requestMatch.index <= filesMatch.index) {
    return null;
  }

  const fileSection = text.slice(filesMatch.index + filesMatch[0].length, requestMatch.index);
  const fileNames = Array.from(
    fileSection.matchAll(/^##\s+(.+?):\s+\/.*$/gm),
    (match) => match[1].trim(),
  ).filter((name) => /\.(?:avif|gif|jpe?g|png|webp)$/i.test(name));
  const request = text
    .slice(requestMatch.index + requestMatch[0].length)
    .trim();

  return { fileNames, request };
}

function renderMessageAttachments(attachments) {
  if (!attachments.length) {
    return "";
  }

  return `
    <div class="task-message-attachments" aria-label="Attached images">
      ${attachments
        .map(
          (attachment) => `
            <figure class="task-message-attachment">
              ${attachment.src ? `
                <button
                  type="button"
                  class="task-message-attachment-preview"
                  data-conversation-action="preview-image"
                  data-image-name="${escapeHtml(attachment.name)}"
                  aria-label="Preview ${escapeHtml(attachment.name)}"
                  title="Preview image"
                >
                  <img src="${escapeHtml(attachment.src)}" alt="" loading="lazy">
                </button>
              ` : `
                <div class="task-message-attachment-preview task-message-attachment-unavailable">
                  ${renderInlineIcon("ImageOff", "Image preview unavailable", "task-message-attachment-placeholder-icon")}
                  <span>Preview unavailable</span>
                </div>
              `}
              <figcaption title="${escapeHtml(attachment.name)}">
                ${renderInlineIcon("FileImage", "Attached image", "task-message-attachment-icon")}
                <span>${escapeHtml(attachment.name)}</span>
              </figcaption>
            </figure>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderThinkingEvent(event, text, task, eventState) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }
  const isActive =
    eventState?.active ??
    isTaskActivelyWorking(task);
  const open = isActive ? " open" : "";
  const state = isActive ? "active" : "complete";

  return `
    <li class="task-event task-thinking" data-event-type="${escapeHtml(event.type)}" data-thinking-state="${escapeHtml(state)}">
      <details${open}${disclosureIdentityAttribute("thinking", eventIdentityKey(event))}>
        <summary>
          <span>Thinking</span>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <div class="task-thinking-content">
          <caffold-task-markdown>${escapeHtml(value)}</caffold-task-markdown>
        </div>
      </details>
    </li>
  `;
}

function renderTurnWorkSummary(
  group,
  workEvents,
  terminalEvent,
  task,
  workDetails,
) {
  const duration = turnDurationLabel(group.events, terminalEvent);
  const count = turnWorkItemCount(workEvents);
  const updateText = count === 1 ? "1 update" : `${count} updates`;
  const label = duration ? `Worked for ${duration}` : "Work details";
  const threadId = `${task?.threadId ?? task?.id ?? workEvents[0]?.threadId ?? ""}`;
  const disclosureKey = `turn-work:${turnGroupDisclosureIdentity(group)}`;
  const identity = `${threadId}:${disclosureKey}`;
  workDetails.set(identity, {
    identity,
    label,
    updateText,
    events: [...workEvents],
  });
  return `
    <li class="task-event task-turn-work" data-turn-id="${escapeHtml(group.turnId)}" data-conversation-entry-key="${escapeHtml(identity)}">
      <caffold-task-work-details></caffold-task-work-details>
    </li>
  `;
}

function turnWorkItemCount(events) {
  let count = 0;
  let combinedType = "";
  for (const event of events) {
    if (["reasoning", "file_change"].includes(event.type)) {
      if (combinedType !== event.type) {
        count += 1;
        combinedType = event.type;
      }
      continue;
    }
    combinedType = "";
    count += 1;
  }
  return count;
}

function turnDurationLabel(events, terminalEvent) {
  const started = events.find((event) => event.type === "turn_started");
  const startMs = started?.createdMs ?? events[0]?.createdMs;
  const endMs = terminalEvent?.createdMs ?? events.at(-1)?.createdMs;
  if (typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) {
    return "";
  }
  return formatDuration(endMs - startMs);
}

function renderToolEvent(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }

  return `
    <li class="task-event task-tool-card" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      <pre>${escapeHtml(value)}</pre>
    </li>
  `;
}

function renderCommandEvent(event) {
  const payload = event.payload ?? {};
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const status = `${payload.status ?? ""}`.trim();
  const output = `${payload.aggregatedOutput ?? ""}`.trim();
  if (isTerminalCommandStatus(status)) {
    return `
      <li class="task-event task-command"${eventIdentityAttribute(event)} data-event-type="${escapeHtml(event.type)}" data-command-status="${escapeHtml(commandResultStatus(payload))}" data-command-terminal="true">
        ${renderTerminalCommandSummary(event)}
      </li>
    `;
  }
  const details = [
    command ? `$ ${command}` : "",
    cwd ? `cwd: ${cwd}` : "",
    status ? `status: ${status}` : "",
    output,
  ]
    .filter(Boolean)
    .join("\n");
  const open = status && status !== "completed" ? " open" : "";
  return `
    <li class="task-event task-command" data-event-type="${escapeHtml(event.type)}" data-command-status="${escapeHtml(status || "unknown")}">
      <details${open}${disclosureIdentityAttribute("command", eventIdentityKey(event))}>
        <summary>
          <span>Command</span>
          ${status ? `<span>${escapeHtml(formatStatus(status))}</span>` : ""}
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <pre>${escapeHtml(details || "(command unavailable)")}</pre>
      </details>
    </li>
  `;
}

function renderTerminalCommandSummary(event) {
  const payload = event.payload ?? {};
  const command = `${payload.command ?? ""}`.trim() || "(command unavailable)";
  const status = commandResultStatus(payload);
  const duration = finiteNumber(payload.durationMs);
  const exitCode = finiteNumber(payload.exitCode);
  const metadata = [
    duration !== null ? formatDuration(duration) : "",
    status === "failed" && exitCode !== null ? `Exit ${exitCode}` : "",
  ].filter(Boolean);
  return `
    <button
      type="button"
      class="task-command-summary"
      data-conversation-action="view-command-output"
      data-command-key="${escapeHtml(eventIdentityKey(event))}"
      aria-haspopup="dialog"
    >
      <span class="task-command-summary-status" data-command-result="${escapeHtml(status)}">${status === "failed" ? "Failed" : "Completed"}</span>
      <code class="task-command-summary-label">${escapeHtml(command)}</code>
      ${metadata.length ? `<span class="task-command-summary-meta">${escapeHtml(metadata.join(" · "))}</span>` : ""}
      <span class="task-command-summary-action">View output</span>
    </button>
  `;
}

function isTerminalCommandStatus(status) {
  return ["completed", "failed"].includes(`${status ?? ""}`);
}

function commandResultStatus(payload) {
  const exitCode = finiteNumber(payload.exitCode);
  return payload.status === "failed" || (exitCode !== null && exitCode !== 0)
    ? "failed"
    : "completed";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderFileChangeEvent(event) {
  const payload = event.payload ?? {};
  const count =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : 0;
  const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
  const summary = count === 1 ? "1 changed file" : `${count} changed files`;
  return `
    <li class="task-event task-file-change" data-event-type="${escapeHtml(event.type)}">
      <article>
        <header>
          <strong>Files changed</strong>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </header>
        <p>${escapeHtml(summary)}${status ? ` · ${status}` : ""}</p>
        ${renderChangedFilePaths(fileChangePaths([event]))}
      </article>
    </li>
  `;
}

function renderChangedFilePaths(paths) {
  if (!paths.length) {
    return "";
  }

  return `
    <ul class="task-changed-files" aria-label="Changed files">
      ${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}
    </ul>
  `;
}

function renderApprovalCard(event, options = {}) {
  const payload = event.payload ?? {};
  const params = payload.params ?? {};
  const approvalId = payload.approvalId ?? "";
  const requestError = options.approvalErrors?.get(approvalId) ?? null;
  const isCommand = payload.kind === "command";
  const decisions = params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];

  return `
    <article class="task-approval-card">
      <header>
        <h3>${isCommand ? "Command Approval" : "File Change Approval"}</h3>
        <span>${escapeHtml(params.reason ?? "Approval requested")}</span>
      </header>
      ${
        isCommand
          ? `<pre>${escapeHtml(formatCommand(params.command))}</pre>
             <p>${escapeHtml(params.cwd ?? "")}</p>`
          : `<p>${escapeHtml(params.grantRoot ? `Grant root: ${params.grantRoot}` : "File change permission requested")}</p>`
      }
      ${
        requestError
          ? `<p class="task-approval-error" role="alert">${escapeHtml(requestError.message ?? requestError)}</p>`
          : ""
      }
      <div class="task-approval-actions">
        ${decisions
          .filter((decision) => ["accept", "acceptForSession", "decline", "cancel"].includes(decision))
          .map(
            (decision) =>
              `<button type="button" class="task-secondary-button" data-task-action="approval" data-approval-id="${escapeHtml(approvalId)}" data-decision="${escapeHtml(decision)}" ${options.disabled ? "disabled" : ""}>${escapeHtml(formatDecision(decision))}</button>`,
          )
          .join("")}
      </div>
    </article>
  `;
}

function statusTone(type) {
  if (type === "task_failed" || type === "turn_interrupted") {
    return "danger";
  }
  if (type === "approval_requested") {
    return "warning";
  }
  return "muted";
}
