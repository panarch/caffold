import { escapeHtml } from "../../../../../../../components/dom.js";
import { renderInlineIcon } from "../../../../../../../components/icons.js";
import {
  PROMPT_SUBMISSION_STATE,
  isTaskActivelyWorking,
  promptSubmissionState,
} from "../../../../runtime-state.js";
import {
  assistantMessagePhase,
  canAcceptTurnContinuation,
  conversationGroups,
  dedupeCanonicalEvents,
  eventIdentityKey,
  eventTurnId,
  fileChangePathPresentations,
  isFinalAssistantEvent,
  isImplicitTurnEvent,
  isTerminalTurnEvent,
  isTurnContinuationEvent,
  isTurnStatusEvent,
  isWorkEvent,
  sortEventsChronologically,
} from "../../../../task-events.js";
import {
  effectiveTaskFileRoot,
  formatDate,
  formatDecision,
  formatDuration,
  formatStatus,
  taskEventObservedMs,
  toolCallPresentation,
} from "../../../../task-format.js";
import { activeTurnPresentation } from "./components/active-turn/model.js";
export function renderConversation(events, task, approvals = [], options = {}) {
  const activeTurns = new Map();
  const workDetails = new Map();
  const changedFiles = new Map();
  const commands = new Map();
  const filePathPresentationBase = effectiveTaskFileRoot(task);
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
          changedFiles,
          commands,
          filePathPresentationBase,
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
          renderConversationEvent(group.event, task, {
            active: false,
            changedFiles,
            commands,
            filePathPresentationBase,
          }),
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
      activeTurns,
    );
  }
  return { html, activeTurns, workDetails, changedFiles, commands };
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
      options.filePathPresentationBase,
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
          options.filePathPresentationBase,
          options.changedFiles,
          options.commands,
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
  filePathPresentationBase = "",
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
  // A failure stands on its own beside the messages: it is why nothing
  // happened, and must not need work details expanded to be seen.
  const failures = group.events.filter((event) => event.type === "agent_failure");
  const approvals = group.events.filter(
    (event) =>
      event.type === "approval_requested" &&
      pendingApprovalIds.has(event.payload?.approvalId),
  );

  for (const event of userEvents) {
    output.push(
      renderedTimelineEntry(
        [event],
        renderConversationEvent(event, task, {
          active: false,
          filePathPresentationBase,
        }),
        eventOrder,
      ),
    );
  }
  if (workEvents.length > 0) {
    const workSummaryAnchor = workEvents.at(-1);
    output.push(
      renderedTimelineEntry(
        [workSummaryAnchor],
        renderTurnWorkSummary(
          group,
          workEvents,
          terminalEvent,
          task,
          workDetails,
          filePathPresentationBase,
        ),
        eventOrder,
      ),
    );
  }
  for (const event of generatedImages) {
    output.push(
      renderedTimelineEntry(
        [event],
        renderConversationEvent(event, task, {
          active: false,
          filePathPresentationBase,
        }),
        eventOrder,
      ),
    );
  }
  for (const event of failures) {
    output.push(
      renderedTimelineEntry(
        [event],
        renderConversationEvent(event, task, {
          active: false,
          filePathPresentationBase,
        }),
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
          filePathPresentationBase,
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
  filePathPresentationBase = "",
  changedFiles = new Map(),
  commands = new Map(),
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
    // A failure stands beside the messages rather than folding into work
    // details: it is why nothing happened, and must not need expanding.
    event.type === "agent_failure" ||
    isWorkEvent(event)
  ) {
    return renderConversationEvent(event, task, {
      active: isWorkEvent(event),
      changedFiles,
      commands,
      filePathPresentationBase,
    });
  }
  return "";
}

function renderActiveTurnStatus(group, task, activeTurns) {
  const presentation = activeTurnPresentation(group.events, task);
  const threadId = `${task?.threadId ?? task?.id ?? ""}`.trim();
  const turnId = `${group.turnId ?? task?.activeTurn?.id ?? "active-turn"}`;
  const identity = `active-turn:${threadId}:${turnId}`;
  activeTurns.set(identity, presentation);
  const startedAttribute = presentation.startedMs
    ? ` data-active-turn-started-ms="${escapeHtml(presentation.startedMs)}"`
    : "";
  return `
    <li
      class="task-event task-turn-active"
      ${startedAttribute}
      data-turn-id="${escapeHtml(turnId)}"
      data-conversation-entry-key="${escapeHtml(identity)}"
    >
      <caffold-task-active-turn></caffold-task-active-turn>
    </li>
  `;
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
    "tool_call",
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
      attachments: payload.available ? [generatedImagePresentation(event)] : [],
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
    return renderCommandEvent(event, eventState?.commands);
  }
  if (event.type === "file_change") {
    return renderFileChangeEvent(
      event,
      eventState?.filePathPresentationBase,
      eventState?.changedFiles,
    );
  }
  if (event.type === "tool_call") {
    const tool = toolCallPresentation(payload);
    return renderToolEvent(event, tool.label, tool.text, tool.tone);
  }
  if (event.type === "agent_failure") {
    return renderToolEvent(event, "Error", payload.text, "danger");
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
      ${renderObservedTime(event)}
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
  const codeBlockControls =
    (role === "user" && !submissionState) ||
    (role === "assistant" && options.phase === "final");
  const codeBlockControlsAttribute = codeBlockControls
    ? " code-block-controls"
    : "";
  const deliveryAttribute = submissionState
    ? ` data-delivery-state="${escapeHtml(submissionState)}"`
    : "";
  const deliveryLabel = {
    [PROMPT_SUBMISSION_STATE.SENDING]: "Sending...",
    [PROMPT_SUBMISSION_STATE.ACCEPTED]: "Accepted - syncing...",
    [PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN]: "Delivery unconfirmed",
  }[submissionState] ?? "";

  return `
    <li class="task-event task-message"${eventIdentityAttribute(event)}${conversationEntryAttributes(event, `${role}:${options.phase ?? ""}:${submissionState}`)} data-event-type="${escapeHtml(event.type)}" data-message-role="${escapeHtml(role)}"${phaseAttribute}${attachmentsAttribute}${deliveryAttribute}>
      <div class="task-message-header">
        ${deliveryLabel ? `<span class="task-message-delivery">${escapeHtml(deliveryLabel)}</span>` : ""}
        ${renderObservedTime(event)}
      </div>
      ${renderMessageAttachments(attachments)}
      ${value ? `
        <div class="task-message-content">
          <caffold-task-markdown${markdownContextAttributes(event)}${codeBlockControlsAttribute}>${escapeHtml(value)}</caffold-task-markdown>
        </div>
      ` : ""}
    </li>
  `;
}

function eventIdentityAttribute(event) {
  const eventId = `${event?.id ?? ""}`.trim();
  return eventId ? ` data-event-id="${escapeHtml(eventId)}"` : "";
}

function markdownContextAttributes(event) {
  const threadId = `${event?.threadId ?? event?.payload?.threadId ?? ""}`.trim();
  const fileLinks = Array.isArray(event?.fileLinks) ? event.fileLinks : [];
  return `${threadId ? ` thread-id="${escapeHtml(threadId)}"` : ""}${
    fileLinks.length
      ? ` file-links="${escapeHtml(JSON.stringify(fileLinks))}"`
      : ""
  }`;
}

function conversationEntryAttributes(event, presentation = "") {
  const key = eventIdentityKey(event) || `${event?.id ?? ""}`;
  if (!key) {
    return "";
  }
  const version = contentVersion([
    event?.type,
    event?.summary,
    event?.payload,
    event?.createdMs,
    event?.updatedMs,
    event?.fileLinks,
    presentation,
  ]);
  return ` data-conversation-entry-key="${escapeHtml(key)}" data-conversation-entry-version="${version}"`;
}

function contentVersion(value) {
  const content = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`;
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
  return Array.isArray(payload?.content) ? payload.content : [];
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
    <li class="task-event task-thinking"${conversationEntryAttributes(event, state)} data-event-type="${escapeHtml(event.type)}" data-thinking-state="${escapeHtml(state)}">
      <details${open}${disclosureIdentityAttribute("thinking", eventIdentityKey(event))}>
        <summary>
          <span>Thinking</span>
          ${renderObservedTime(event)}
        </summary>
        <div class="task-thinking-content">
          <caffold-task-markdown${markdownContextAttributes(event)}>${escapeHtml(value)}</caffold-task-markdown>
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
  filePathPresentationBase,
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
    filePathPresentationBase,
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
        ${renderObservedTime(event)}
      </header>
      <pre>${escapeHtml(value)}</pre>
    </li>
  `;
}

function renderCommandEvent(event, commands = new Map()) {
  const identity = eventIdentityKey(event) || `${event?.id ?? ""}`;
  if (identity) {
    commands.set(identity, event);
  }
  return `
    <li class="task-event task-command"${eventIdentityAttribute(event)} data-conversation-entry-key="${escapeHtml(identity)}" data-event-type="${escapeHtml(event.type)}">
      <caffold-task-command></caffold-task-command>
    </li>
  `;
}

function renderFileChangeEvent(
  event,
  filePathPresentationBase = "",
  changedFiles = new Map(),
) {
  const payload = event.payload ?? {};
  const count = Array.isArray(payload.paths) ? payload.paths.length : 0;
  const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
  const summary = count === 1 ? "1 changed file" : `${count} changed files`;
  const identity = fileChangeEventIdentity(event);
  changedFiles.set(identity, {
    files: fileChangePathPresentations([event], filePathPresentationBase),
  });
  return `
    <li class="task-event task-file-change"${eventIdentityAttribute(event)} data-conversation-entry-key="${escapeHtml(identity)}" data-event-type="${escapeHtml(event.type)}">
      <article>
        <header>
          <strong>Files changed</strong>
          ${renderObservedTime(event)}
        </header>
        <p>${escapeHtml(summary)}${status ? ` · ${status}` : ""}</p>
        <caffold-task-changed-files></caffold-task-changed-files>
      </article>
    </li>
  `;
}

function renderObservedTime(event) {
  const observedMs = taskEventObservedMs(event);
  return observedMs === null
    ? ""
    : `<time>${escapeHtml(formatDate(observedMs))}</time>`;
}

function fileChangeEventIdentity(event) {
  return (
    eventIdentityKey(event) ||
    [
      "file-change",
      event?.threadId ?? event?.payload?.threadId ?? "",
      event?.createdMs ?? "",
    ].join(":")
  );
}

function renderApprovalCard(event, options = {}) {
  const payload = event.payload ?? {};
  const approvalId = payload.approvalId ?? "";
  const requestError = options.approvalErrors?.get(approvalId) ?? null;

  return `
    <article class="task-approval-card">
      <header>
        <h3>${escapeHtml(payload.title ?? "Approval requested")}</h3>
        ${payload.reason ? `<p class="task-approval-reason">${escapeHtml(payload.reason)}</p>` : ""}
      </header>
      ${renderApprovalDetails(payload)}
      ${
        requestError
          ? `<p class="task-approval-error" role="alert">${escapeHtml(requestError.message ?? requestError)}</p>`
          : ""
      }
      <div class="task-approval-actions">
        ${renderApprovalActions(payload.decisions, approvalId, options.disabled)}
      </div>
    </article>
  `;
}

/**
 * The specifics of one request, in the order a reader checks them: what would
 * run, what it would reach, and where. Every part is optional because requests
 * differ, so this renders what is present rather than switching on a kind.
 */
function renderApprovalDetails(payload) {
  const command = `${payload.command ?? ""}`.trim();
  const sections = [
    command
      ? `<pre class="task-approval-command"><code>${escapeHtml(command)}</code></pre>`
      : "",
    payload.networkEndpoint
      ? renderApprovalDefinitionList(
          [
            {
              label: "Network destination",
              value: `${payload.networkEndpoint}`,
              code: true,
            },
          ],
          "Network request",
        )
      : "",
    renderPermissionRows(payload.permissions),
    renderApprovalContext(payload),
  ];
  return sections.filter(Boolean).join("");
}

function renderPermissionRows(permissions) {
  if (!Array.isArray(permissions) || !permissions.length) {
    return "";
  }
  return renderApprovalDefinitionList(
    permissions.map((row) => ({
      label: `${row?.label ?? ""}`,
      value: `${row?.value ?? ""}`,
      code: Boolean(row?.verbatim),
    })),
    "Requested permissions",
  );
}

function renderApprovalContext(payload) {
  const rows = [
    ["Grant root", payload.grantRoot],
    ["Working directory", payload.cwd],
    ["Environment", payload.environment],
  ]
    .filter(([, value]) => `${value ?? ""}`.trim())
    .map(([label, value]) => ({ label, value: `${value}`, code: true }));
  return rows.length ? renderApprovalDefinitionList(rows, "Request context") : "";
}

function renderApprovalActions(decisions, approvalId, disabled) {
  const offered = Array.isArray(decisions) ? decisions : [];
  return offered
    .map(
      (decision) =>
        `<button type="button" class="task-secondary-button" data-task-action="approval" data-approval-id="${escapeHtml(approvalId)}" data-decision="${escapeHtml(decision)}" ${disabled ? "disabled" : ""}>${escapeHtml(formatDecision(decision))}</button>`,
    )
    .join("");
}

function renderApprovalDefinitionList(rows, label) {
  return `
    <dl class="task-approval-details" aria-label="${escapeHtml(label)}">
      ${rows
        .map(
          (row) => `<div>
            <dt>${escapeHtml(row.label)}</dt>
            <dd>${row.code ? `<code>${renderBreakableCode(row.value)}</code>` : escapeHtml(row.value)}</dd>
          </div>`,
        )
        .join("")}
    </dl>
  `;
}

function renderBreakableCode(value) {
  return escapeHtml(value)
    .replaceAll("/", "/<wbr>")
    .replaceAll("\\", "\\<wbr>");
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
