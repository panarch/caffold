import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationGroups,
  dedupeCanonicalEvents,
  fileChangePathPresentations,
  mergeEvents,
  optimisticUserMessageEvent,
  reconcileCanonicalEvents,
} from "./task-events.js";

function event(id, type, createdMs, payload = {}, overrides = {}) {
  return {
    id,
    threadId: "thread-1",
    type,
    summary: type,
    payload,
    createdMs,
    ...overrides,
  };
}

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

test("event merge keeps causal order while a newer canonical record wins", () => {
  const started = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      status: "inProgress",
      command: "cargo test",
    },
    { sortIndex: 2 },
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
    { updatedMs: 140, sortIndex: 9 },
  );
  const earlier = event("message-1", "assistant_message", 90, {
    turnId: "turn-1",
    text: "Before command",
  });

  const merged = mergeEvents([started], [completed, earlier]);

  assert.deepEqual(merged.map(({ id }) => id), ["message-1", "item-1"]);
  assert.equal(merged[1].createdMs, 100);
  assert.equal(merged[1].sortIndex, 2);
  assert.equal(merged[1].updatedMs, 140);
  // The newer record wins where the two disagree, and what only the earlier
  // one carried survives.
  assert.deepEqual(merged[1].payload, {
    itemId: "item-1",
    status: "completed",
    command: "cargo test",
    output: "done",
  });
});

test("canonical user message replaces only its matching optimistic event", () => {
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

  const merged = mergeEvents([matching, unrelated], [canonical]);

  assert.deepEqual(merged.map(({ id }) => id), [unrelated.id, "canonical-1"]);
});

test("structured canonical duplicates beat sparse notifications", () => {
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
    { sortIndex: 0 },
  );

  assert.deepEqual(dedupeCanonicalEvents([sparse, canonical]), [canonical]);
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
    reconcileCanonicalEvents([], [first, second]).map(({ id }) => id),
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
    mergeEvents([first], [second]).map(({ id }) => id),
    ["notification-1", "notification-2"],
    "matching content is not evidence that two unstructured events are one",
  );
});

test("a background answer stays once and in order across live and canonical refreshes", () => {
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
  const canonical = event(
    "canonical-background",
    "assistant_message",
    20,
    {
      turnId: "background-turn",
      itemId: "background-answer",
      text: "The build is done.",
      phase: "final",
    },
    { sortIndex: 1 },
  );

  const liveState = mergeEvents([earlier], [live]);
  const refreshed = reconcileCanonicalEvents(liveState, [earlier, canonical]);
  const refreshedAgain = reconcileCanonicalEvents(refreshed, [earlier, canonical]);
  const reloaded = reconcileCanonicalEvents([], [earlier, canonical]);

  for (const state of [refreshed, refreshedAgain, reloaded]) {
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

  const reconciled = reconcileCanonicalEvents([started], [
    { ...finished, updatedMs: 200 },
  ]);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].payload.status, "completed");
  assert.equal(
    reconciled[0].createdMs,
    100,
    "finishing an item must not move it from its place in the turn",
  );
});

test("canonical reconciliation retains unrelated current and canonical events", () => {
  const current = event("current-message", "assistant_message", 100, {
    turnId: "turn-1",
    text: "Already loaded.",
  });
  const canonical = event("canonical-message", "assistant_message", 200, {
    turnId: "turn-2",
    text: "New canonical event.",
  });

  const reconciled = reconcileCanonicalEvents([current], [canonical]);

  assert.deepEqual(reconciled, [current, canonical]);
});

test("canonical reconciliation preserves ordinary merge semantics for matching projections", () => {
  const current = event(
    "thread-1:turn-1:command-1",
    "command_execution",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "inProgress",
      output: "Preserve this output.",
    },
  );
  const canonical = event(
    "thread-1:turn-1:command-1",
    "command_execution",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      status: "completed",
      exitCode: 0,
    },
    { sortIndex: 3 },
  );

  const reconciled = reconcileCanonicalEvents([current], [canonical]);

  assert.deepEqual(reconciled, mergeEvents([current], [canonical]));
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
