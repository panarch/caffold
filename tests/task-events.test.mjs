import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationGroups,
  dedupeCanonicalEvents,
  mergeEvents,
  optimisticUserMessageEvent,
  reconcileCanonicalEvents,
} from "../frontend/pages/(task-workspace)/tasks/task-events.js";

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

test("event merge keeps causal order while a newer canonical record wins", () => {
  const started = event(
    "item-1",
    "command_execution",
    100,
    {
      itemId: "item-1",
      item: { id: "item-1", status: "inProgress" },
    },
    { sortIndex: 2 },
  );
  const completed = event(
    "item-1",
    "command_execution",
    120,
    {
      itemId: "item-1",
      item: { id: "item-1", status: "completed", output: "done" },
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
  assert.deepEqual(merged[1].payload.item, {
    id: "item-1",
    status: "completed",
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
    text: "Ship it",
    item: {
      id: "item-user-1",
      content: [
        { type: "text", text: "Ship it" },
        { type: "image", name: "plan.png", url: "data:image/png;base64,AAAA" },
      ],
    },
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

test("canonical item projection replaces a newer transient lifecycle placeholder", () => {
  const transient = event(
    "thread-1:turn-1:item-1",
    "work_status",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "agentMessage",
      lifecycle: "started",
    },
  );
  const canonical = event(
    "thread-1:turn-1:item-1",
    "assistant_message",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      phase: "final",
      text: "Canonical response after reconnect.",
    },
    { sortIndex: 2 },
  );

  const reconciled = reconcileCanonicalEvents([transient], [canonical]);

  assert.deepEqual(reconciled, [canonical]);
});

test("canonical reconciliation does not regress a useful item to a transient placeholder", () => {
  const current = event(
    "thread-1:turn-1:item-1",
    "assistant_message",
    100,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      phase: "final",
      text: "Keep the last useful response.",
    },
    { sortIndex: 2 },
  );
  const transient = event(
    "thread-1:turn-1:item-1",
    "work_status",
    200,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "agentMessage",
      lifecycle: "started",
    },
  );

  const reconciled = reconcileCanonicalEvents([current], [transient]);

  assert.deepEqual(reconciled, [current]);
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
      aggregatedOutput: "Preserve this output.",
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
