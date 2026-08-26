import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectionDeltas,
  appendOptimisticEvent,
  conversationGroups,
  dedupeCanonicalEvents,
  fileChangePathPresentations,
  handoffOptimisticSubmission,
  optimisticUserMessageEvent,
  prependDetailEvents,
  projectCanonicalEvents,
  projectHistoryLoadingEvents,
  sortEventsChronologically,
  taskEventPosition,
} from "./task-events.js";

function event(id, type, anchorMs, payload = {}, overrides = {}) {
  const { positionIndex = 0, ...recordOverrides } = overrides;
  return {
    id,
    threadId: "thread-1",
    type,
    summary: type,
    payload,
    position: { anchorMs, index: positionIndex },
    ...recordOverrides,
  };
}

test("equal positions preserve projection order instead of inferring from event IDs", () => {
  const first = event("z-event", "assistant_message", 100, {
    text: "Observed first",
  });
  const second = event("a-event", "assistant_message", 100, {
    text: "Observed second",
  });

  assert.deepEqual(
    sortEventsChronologically([first, second]).map(({ id }) => id),
    ["z-event", "a-event"],
  );
});

test("an event without canonical position preserves projection order instead of inventing an anchor", () => {
  const later = event("later", "assistant_message", 200);
  const unpositioned = {
    ...event("unpositioned", "assistant_message", 150),
    position: undefined,
  };
  const earlier = event("earlier", "assistant_message", 100);

  assert.equal(taskEventPosition(unpositioned), null);
  assert.deepEqual(
    sortEventsChronologically([later, unpositioned, earlier]).map(({ id }) => id),
    ["later", "unpositioned", "earlier"],
  );
  const merged = applyProjectionDeltas([unpositioned], [
    { ...unpositioned, summary: "Later observation" },
  ]);
  assert.equal(merged[0].position, undefined);
  assert.equal(Object.hasOwn(merged[0], "updatedMs"), false);
});

test("file change presentation deduplicates equivalent Task-local references", () => {
  const rootPath = "/managed/worktrees/task-1";
  const absolutePath = `${rootPath}/src/./lib.rs`;
  const fileChanges = [
    event("file-1", "file_change", 1, {
      paths: [absolutePath, "src/lib.rs"],
    }),
    event("file-2", "file_change", 2, {
      paths: ["src\\lib.rs", "/managed/worktrees/task-1-copy/src/lib.rs"],
    }),
  ];
  const canonicalEvents = structuredClone(fileChanges);

  assert.deepEqual(fileChangePathPresentations(fileChanges, rootPath), [
    {
      fileIdentity: "/managed/worktrees/task-1/src/lib.rs",
      originalPath: absolutePath,
      displayPath: "src/lib.rs",
    },
    {
      fileIdentity: "/managed/worktrees/task-1-copy/src/lib.rs",
      originalPath: "/managed/worktrees/task-1-copy/src/lib.rs",
      displayPath: "/managed/worktrees/task-1-copy/src/lib.rs",
    },
  ]);
  assert.deepEqual(fileChanges, canonicalEvents);
});

test("projection deltas keep first position while the incoming patch wins", () => {
  const started = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      status: "inProgress",
      command: "cargo test",
    },
    { observedMs: 100, positionIndex: 2 },
  );
  const completed = event(
    "item-1",
    "command_execution",
    120,
    {
      itemId: "item-1",
      status: "completed",
      output: "done",
    },
    { observedMs: 120, positionIndex: 9 },
  );
  const earlier = event("message-1", "assistant_message", 90, {
    turnId: "turn-1",
    text: "Before command",
  });

  const merged = applyProjectionDeltas([started], [completed, earlier]);

  assert.deepEqual(merged.map(({ id }) => id), ["message-1", "item-1"]);
  assert.deepEqual(merged[1].position, { anchorMs: 100, index: 2 });
  assert.equal(Object.hasOwn(merged[1], "updatedMs"), false);
  assert.equal(merged[1].observedMs, 100);
  // The newer record wins where the two disagree, and what only the earlier
  // one carried survives.
  assert.deepEqual(merged[1].payload, {
    itemId: "item-1",
    status: "completed",
    command: "cargo test",
    output: "done",
  });
});

test("projection deltas do not reinterpret backend lifecycle state", () => {
  const started = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      status: "inProgress",
      command: "cargo test",
      output: "started",
    },
  );
  const completed = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      status: "completed",
      command: "cargo test",
      output: "done",
    },
    { summary: "Command completed" },
  );
  const replay = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      status: "inProgress",
      command: "cargo test",
      output: "replayed partial output",
      replayOnly: true,
    },
    { summary: "Command running again" },
  );

  const merged = applyProjectionDeltas(
    applyProjectionDeltas([started], [completed]),
    [replay],
  );

  assert.equal(merged[0].summary, "Command running again");
  assert.equal(merged[0].payload.status, "inProgress");
  assert.equal(merged[0].payload.output, "replayed partial output");
  assert.equal(merged[0].payload.replayOnly, true);
});

test("an optimistic overlay remains separate until exact handoff", () => {
  const originalNow = Date.now;
  Date.now = () => 100;
  const matching = optimisticUserMessageEvent(
    "thread-1",
    "Ship it",
    [{ name: "plan.png", dataUrl: "data:image/png;base64,AAAA" }],
    "submission-1",
  );
  const unrelated = optimisticUserMessageEvent(
    "thread-1",
    "Keep this",
    [],
    "submission-2",
  );
  Date.now = originalNow;

  const canonical = event("canonical-1", "user_message", 120, {
    turnId: "turn-1",
    itemId: "item-user-1",
    text: "Ship it",
    content: [
      { type: "text", text: "Ship it" },
      { type: "image", name: "plan.png", url: "data:image/png;base64,AAAA" },
    ],
  });

  const overlays = appendOptimisticEvent(
    appendOptimisticEvent([], matching),
    unrelated,
  );
  const merged = applyProjectionDeltas(overlays, [canonical]);

  assert.deepEqual(merged.map(({ id }) => id), [
    matching.id,
    unrelated.id,
    "canonical-1",
  ]);
});

test("a canonical snapshot keeps a new identical optimistic overlay separate", () => {
  const canonical = event("canonical-1", "user_message", 100, {
    turnId: "turn-1",
    itemId: "message-1",
    text: "Repeat this",
  });
  const optimistic = optimisticUserMessageEvent(
    "thread-1",
    "Repeat this",
    [],
    "submission-2",
  );

  assert.deepEqual(
    projectCanonicalEvents([canonical], [], [optimistic]).map(({ id }) => id),
    ["canonical-1", optimistic.id],
    "presentation text cannot identify a later submission",
  );
});

test("accepted and later user-item projections merge by exact identity in either order", () => {
  const accepted = event("accepted-projection", "user_message", 100, {
    turnId: "turn-1",
    itemId: "message-1",
    text: "Keep one",
    status: "completed",
  });
  const providerProjection = event("provider-projection", "user_message", 120, {
    turnId: "turn-1",
    itemId: "message-1",
    text: "Keep one",
    content: [{ type: "text", text: "Keep one" }],
    status: "completed",
  });

  for (const [first, second] of [
    [accepted, providerProjection],
    [providerProjection, accepted],
  ]) {
    const merged = applyProjectionDeltas([first], [second]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].payload.itemId, "message-1");
    assert.deepEqual(merged[0].payload.content, [
      { type: "text", text: "Keep one" },
    ]);
  }
});

test("two accepted user items survive identical presentation", () => {
  const first = event("accepted-1", "user_message", 100, {
    turnId: "turn-1",
    itemId: "message-1",
    text: "Again",
  });
  const second = event("accepted-2", "user_message", 101, {
    turnId: "turn-1",
    itemId: "message-2",
    text: "Again",
  });

  assert.deepEqual(
    applyProjectionDeltas([first], [second]).map((entry) => entry.payload.itemId),
    ["message-1", "message-2"],
  );
});

test("equal sparse and structured messages remain separate without exact identity", () => {
  const sparse = event("notification-1", "assistant_message", 100, {
    turnId: "turn-1",
    text: "Finished",
    phase: "final",
  });
  const canonical = event(
    "canonical-1",
    "assistant_message",
    90,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "Finished",
      phase: "final",
    },
    { positionIndex: 0 },
  );

  assert.deepEqual(
    dedupeCanonicalEvents([sparse, canonical]).map(({ id }) => id),
    ["notification-1", "canonical-1"],
    "presentation equality cannot manufacture an identity relationship",
  );
});

test("distinct structured messages survive even when their text is identical", () => {
  const first = event("canonical-1", "assistant_message", 100, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "message-1",
    text: "Same words",
    phase: "progress",
  });
  const second = event("canonical-2", "assistant_message", 101, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "message-2",
    text: "Same words",
    phase: "progress",
  });

  assert.deepEqual(
    projectCanonicalEvents([first, second]).map(({ id }) => id),
    ["canonical-1", "canonical-2"],
    "two stable item identities are two messages, whatever their text says",
  );
});

test("an ambiguous sparse copy is not assigned to either identical structured message", () => {
  const sparse = event("notification", "assistant_message", 99, {
    turnId: "turn-1",
    text: "Same words",
    phase: "progress",
  });
  const first = event("canonical-1", "assistant_message", 100, {
    turnId: "turn-1",
    itemId: "message-1",
    text: "Same words",
    phase: "progress",
  });
  const second = event("canonical-2", "assistant_message", 101, {
    turnId: "turn-1",
    itemId: "message-2",
    text: "Same words",
    phase: "progress",
  });

  assert.deepEqual(
    dedupeCanonicalEvents([sparse, first, second]).map(({ id }) => id),
    ["notification", "canonical-1", "canonical-2"],
    "content alone cannot say which structured item a sparse event repeats",
  );
});

test("two sparse equal messages keep their event identities", () => {
  const first = event("notification-1", "assistant_message", 100, {
    turnId: "turn-1",
    text: "Same words",
    phase: "progress",
  });
  const second = event("notification-2", "assistant_message", 101, {
    turnId: "turn-1",
    text: "Same words",
    phase: "progress",
  });

  assert.deepEqual(
    applyProjectionDeltas([first], [second]).map(({ id }) => id),
    ["notification-1", "notification-2"],
    "matching content is not evidence that two unstructured events are one",
  );
});

test("a backend-selected background ledger stays once across refreshes", () => {
  const earlier = event("earlier", "assistant_message", 10, {
    turnId: "turn-1",
    itemId: "earlier-message",
    text: "The command was started.",
    phase: "final",
  });
  const live = event("live-background", "assistant_message", 21, {
    turnId: "background-turn",
    text: "The build is done.",
    phase: "final",
  });
  const detail = event(
    "live-background",
    "assistant_message",
    20,
    {
      turnId: "background-turn",
      text: "The build is done.",
      phase: "final",
    },
    { positionIndex: 1 },
  );

  const liveState = applyProjectionDeltas([earlier], [live]);
  const refreshed = projectCanonicalEvents([earlier, detail]);
  const refreshedAgain = projectCanonicalEvents([earlier, detail]);
  const reloaded = projectCanonicalEvents([earlier, detail]);

  for (const state of [liveState, refreshed, refreshedAgain, reloaded]) {
    assert.deepEqual(
      state.map((candidate) => candidate.payload.text),
      ["The command was started.", "The build is done."],
    );
    assert.equal(
      state.filter((candidate) => candidate.payload.text === "The build is done.").length,
      1,
    );
  }
});

test("an approval and the command it asks about are separate entries", () => {
  const identity = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" };
  const command = event("thread-1:turn-1:item-1", "command_execution", 100, {
    ...identity,
    status: "inProgress",
    command: "/bin/zsh -lc 'open -a TextEdit'",
  });
  const approval = event("approval_requested:401", "approval_requested", 100, {
    ...identity,
    approvalId: "401",
    title: "Command approval requested",
    command: "/bin/zsh -lc 'open -a TextEdit'",
    decisions: ["allow", "denyAndStop"],
  });

  assert.deepEqual(
    dedupeCanonicalEvents([approval, command]).map(({ id }) => id),
    ["approval_requested:401", "thread-1:turn-1:item-1"],
    "an approval that names its item must not be collapsed into that item",
  );
  assert.deepEqual(
    dedupeCanonicalEvents([command, approval]).map(({ id }) => id),
    ["thread-1:turn-1:item-1", "approval_requested:401"],
    "which of the two arrived first cannot decide whether the card appears",
  );
});

test("an item's start and its finish stay one conversation entry", () => {
  const identity = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" };
  const started = event("thread-1:turn-1:item-1", "command_execution", 100, {
    ...identity,
    status: "inProgress",
    command: "cargo test",
  });
  const finished = event("thread-1:turn-1:item-1", "command_execution", 100, {
    ...identity,
    status: "completed",
    command: "cargo test",
    exitCode: 0,
  });

  const reconciled = applyProjectionDeltas([started], [finished]);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].payload.status, "completed");
  assert.deepEqual(
    reconciled[0].position,
    { anchorMs: 100, index: 0 },
    "finishing an item must not move it from its place in the turn",
  );
});

test("a canonical snapshot replaces unrelated prior projection records", () => {
  const current = event("current-message", "assistant_message", 100, {
    turnId: "turn-1",
    text: "Already loaded.",
  });
  const canonical = event("canonical-message", "assistant_message", 200, {
    turnId: "turn-2",
    text: "New canonical event.",
  });

  const reconciled = projectCanonicalEvents([canonical]);

  assert.deepEqual(reconciled, [canonical]);
  assert.equal(reconciled.includes(current), false);
});

test("a canonical snapshot owns item fields and position without browser enrichment", () => {
  const historyPrompt = event(
    "history-user-message",
    "user_message",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "Test the ordering",
      content: [{ type: "text", text: "Test the ordering" }],
    },
    { positionIndex: 1 },
  );
  const historyAnswer = event(
    "history-answer",
    "assistant_message",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      text: "The answer",
    },
    { positionIndex: 2 },
  );

  const reconciled = projectCanonicalEvents([historyPrompt, historyAnswer]);

  assert.deepEqual(
    reconciled.map((entry) => entry.type),
    ["user_message", "assistant_message"],
    "a late observation cannot move a prompt behind its answer",
  );
  assert.deepEqual(reconciled[0].position, { anchorMs: 100, index: 1 });
  assert.equal(Object.hasOwn(reconciled[0], "updatedMs"), false);
  assert.equal(reconciled[0].payload.liveDelivery, undefined);
  assert.deepEqual(reconciled[0].payload.content, [
    { type: "text", text: "Test the ordering" },
  ]);
});

test("an older Detail page cannot replace the current cursor-boundary item", () => {
  const olderBoundary = event(
    "older-command",
    "tool_call",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "inProgress",
      output: "older partial output",
      olderOnly: true,
    },
    { summary: "Older command", positionIndex: 9 },
  );
  const currentBoundary = event(
    "current-command",
    "command_execution",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "completed",
      output: "current output",
    },
    { summary: "Current command", positionIndex: 1 },
  );
  const olderMessage = event("older-message", "assistant_message", 50, {
    turnId: "turn-0",
    itemId: "message-0",
    text: "Earlier history",
  });

  const projected = prependDetailEvents(
    [currentBoundary],
    [olderMessage, olderBoundary],
  );

  assert.deepEqual(projected.map(({ id }) => id), [
    "older-message",
    "current-command",
  ]);
  assert.equal(projected[1].type, "command_execution");
  assert.equal(projected[1].summary, "Current command");
  assert.deepEqual(projected[1].position, currentBoundary.position);
  assert.equal(projected[1].payload.status, "completed");
  assert.equal(projected[1].payload.output, "current output");
  assert.equal(projected[1].payload.olderOnly, true);
});

test("a history-loading Detail advances exact items without deleting retained history", () => {
  const retainedHistory = event(
    "retained-history",
    "assistant_message",
    50,
    {
      turnId: "turn-0",
      itemId: "message-0",
      text: "Readable provider history",
    },
  );
  const retainedCommand = event(
    "retained-command",
    "tool_call",
    100,
    {
      turnId: "turn-1",
      itemId: "command-1",
      status: "inProgress",
      output: "partial output",
      retainedOnly: true,
    },
    { summary: "Retained command", positionIndex: 4 },
  );
  const currentCommand = event(
    "current-command",
    "command_execution",
    120,
    {
      turnId: "turn-1",
      itemId: "command-1",
      status: "completed",
      output: "complete output",
    },
    { summary: "Current command", positionIndex: 1 },
  );
  const currentMessage = event(
    "current-message",
    "assistant_message",
    130,
    {
      turnId: "turn-1",
      itemId: "message-1",
      text: "Current live projection",
    },
  );

  const projected = projectHistoryLoadingEvents(
    [currentCommand, currentMessage],
    [retainedHistory, retainedCommand],
  );

  assert.deepEqual(projected.map(({ id }) => id), [
    "retained-history",
    "current-command",
    "current-message",
  ]);
  assert.equal(projected[1].type, "command_execution");
  assert.equal(projected[1].summary, "Current command");
  assert.deepEqual(projected[1].position, currentCommand.position);
  assert.equal(projected[1].payload.status, "completed");
  assert.equal(projected[1].payload.output, "complete output");
  assert.equal(projected[1].payload.retainedOnly, true);
  assert.equal(Object.hasOwn(projected[1], "updatedMs"), false);
});

test("canonical Detail requires no retained-live conflict arbitration", () => {
  const staleLive = event(
    "live-command",
    "tool_call",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "inProgress",
      output: "partial",
      structure: "transient",
      liveOnly: true,
    },
    { summary: "Transient command running", positionIndex: 9 },
  );
  const canonical = event(
    "history-command",
    "command_execution",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "completed",
      output: "canonical output",
      structure: { owner: "detail" },
    },
    { summary: "Canonical command completed", positionIndex: 2 },
  );

  const [reconciled] = projectCanonicalEvents([canonical]);

  assert.equal(reconciled.type, "command_execution");
  assert.equal(reconciled.summary, "Canonical command completed");
  assert.deepEqual(reconciled.position, { anchorMs: 100, index: 2 });
  assert.equal(reconciled.payload.status, "completed");
  assert.equal(reconciled.payload.output, "canonical output");
  assert.deepEqual(reconciled.payload.structure, { owner: "detail" });
  assert.equal(reconciled.payload.liveOnly, undefined);
  assert.equal(staleLive.payload.liveOnly, true);
});

test("an exact submission handoff keeps its optimistic position until Detail owns it", () => {
  const optimistic = event(
    "local-user-message",
    "user_message",
    100,
    { optimistic: true, text: "Test the ordering" },
    { positionIndex: 1 },
  );
  const liveAnswer = event(
    "live-answer",
    "assistant_message",
    150,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      text: "The answer",
    },
    { positionIndex: 2 },
  );
  const accepted = event(
    "accepted-user-message",
    "user_message",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "Test the ordering",
      liveDelivery: "accepted",
    },
    { positionIndex: 3 },
  );

  const handedOff = handoffOptimisticSubmission(
    [optimistic, liveAnswer, accepted],
    optimistic.id,
    accepted,
  );

  assert.deepEqual(
    handedOff.map((entry) => entry.type),
    ["user_message", "assistant_message"],
  );
  assert.equal(handedOff[0].id, accepted.id);
  assert.deepEqual(handedOff[0].position, optimistic.position);
  assert.equal(
    Object.hasOwn(handedOff[0], "updatedMs"),
    false,
    "exact handoff must not expose a position-derived update timestamp",
  );
  assert.equal(handedOff[0].payload.liveDelivery, "accepted");
  assert.equal(handedOff[0].payload.optimistic, undefined);

  const historyPrompt = event(
    "history-user-message",
    "user_message",
    120,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "Test the ordering",
    },
    { positionIndex: 1 },
  );
  const historyAnswer = event(
    "history-answer",
    "assistant_message",
    120,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      text: "The answer",
    },
    { positionIndex: 2 },
  );
  const reconciled = projectCanonicalEvents([
    historyPrompt,
    historyAnswer,
  ]);

  assert.deepEqual(reconciled[0].position, historyPrompt.position);
});

test("turn grouping keeps implicit continuation causal and closes terminal turns", () => {
  const events = [
    event("user-1", "user_message", 1, { text: "Start" }),
    event("assistant-1", "assistant_message", 2, { text: "Working" }),
    event("turn-end", "turn_completed", 3, { status: "completed" }),
    event("assistant-2", "assistant_message", 4, { text: "Next turn" }),
  ];

  const groups = conversationGroups(events);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].events.map(({ id }) => id), [
    "user-1",
    "assistant-1",
    "turn-end",
  ]);
  assert.deepEqual(groups[1].events.map(({ id }) => id), ["assistant-2"]);
});

test("generated images remain in their completed conversation turn", () => {
  const events = [
    event("user-1", "user_message", 1, { turnId: "turn-1", text: "Draw it" }),
    event("image-1", "generated_image", 2, {
      turnId: "turn-1",
      itemId: "image-1",
    }),
    event("assistant-1", "assistant_message", 3, {
      turnId: "turn-1",
      text: "Done",
    }),
    event("turn-end", "turn_completed", 4, {
      turnId: "turn-1",
      status: "completed",
    }),
  ];

  const groups = conversationGroups(events);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].events.map(({ id }) => id), [
    "user-1",
    "image-1",
    "assistant-1",
    "turn-end",
  ]);
});

test("turn grouping follows visible message chronology instead of a stale start marker", () => {
  const events = [
    event("new-start", "turn_started", 1, { turnId: "turn-new" }),
    event("old-start", "turn_started", 2, { turnId: "turn-old" }),
    event("old-user", "user_message", 2, {
      turnId: "turn-old",
      text: "Old prompt",
    }),
    event("old-answer", "assistant_message", 3, {
      turnId: "turn-old",
      text: "Old answer",
    }),
    event("old-completed", "turn_completed", 4, {
      turnId: "turn-old",
      status: "completed",
    }),
    event("new-user", "user_message", 10, {
      turnId: "turn-new",
      text: "New prompt",
    }),
    event("new-answer", "assistant_message", 11, {
      turnId: "turn-new",
      text: "New answer",
    }),
    event("new-completed", "turn_completed", 12, {
      turnId: "turn-new",
      status: "completed",
    }),
  ];

  const groups = conversationGroups(events);

  assert.deepEqual(groups.map(({ turnId }) => turnId), [
    "turn-old",
    "turn-new",
  ]);
});
