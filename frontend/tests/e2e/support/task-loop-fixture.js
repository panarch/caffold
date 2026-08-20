import { expect } from "@playwright/test";
import {
  activeTaskProjection,
  canonicalTaskState,
  mockCodexModels,
} from "./task-fixtures.js";

export async function installTaskLoopFixture(
  page,
  {
    completedAssistantResponse: completedAssistantResponseOverride,
    contextPath = "src",
    fileLinks = [],
    threadId = "thread_12345678",
  } = {},
) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve(),
      },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__caffoldMockEventSources.push(this);
        const detailMatch = url.match(/\/api\/tasks\/([^/?]+)\/stream/);
        if (detailMatch) {
          queueMicrotask(async () => {
            const detail = await window.__caffoldTaskDetailBootstrap?.(
              decodeURIComponent(detailMatch[1]),
            );
            if (!detail || this.readyState === 2) {
              return;
            }
            this.emitOpen();
            this.emit("task-sync", {
              threadId: detail.threadId,
              revision: detail.revision,
              detail,
              reason: "stream-bootstrap",
            });
          });
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });

  await mockCodexModels(page);
  const now = 1_767_000_000_000;
  let task = null;
  let events = [];
  let createTaskRequests = 0;
  let followUpRequests = 0;
  let taskDetailReadRequests = 0;
  let approvalRequests = 0;
  let omitCompletedCommandFromDetail = false;
  let resolveFollowUpRequest;
  let releaseFollowUpResponse;
  let resolveCanonicalFollowUpRequest;
  let releaseCanonicalFollowUpResponse;
  const followUpRequested = new Promise((resolve) => {
    resolveFollowUpRequest = resolve;
  });
  const followUpResponseReleased = new Promise((resolve) => {
    releaseFollowUpResponse = resolve;
  });
  const canonicalFollowUpRequested = new Promise((resolve) => {
    resolveCanonicalFollowUpRequest = resolve;
  });
  const canonicalFollowUpResponseReleased = new Promise((resolve) => {
    releaseCanonicalFollowUpResponse = resolve;
  });
  const completedAssistantResponse = completedAssistantResponseOverride ?? [
    "## Review ready",
    "",
    "The planner changes are **ready** to review. Open `Diff` next.",
    "",
    "- Verified planner behavior",
    "- Confirmed fixture coverage",
    "",
    "```text",
    "cargo test",
    "```",
    "",
    "한국어와 English가 함께 있는 결과입니다. [Planner notes](https://example.com/planner)",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Planner | Pass |",
    "",
    `Long token: ${"planner".repeat(24)}`,
    "",
    "Malformed **marker stays readable.",
    "",
    ...Array.from(
      { length: 36 },
      (_, index) =>
        `Review note ${index + 1}: verified planner behavior and fixture coverage.`,
    ),
  ].join("\n");

  const eventRecord = (id, type, summary, payload = null, offset = 0) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const detailResponse = (overrides = {}) => {
    const responseEvents = overrides.events ?? events;
    const eventIds = new Set(responseEvents.map((event) => event.id));
    return {
      threadId,
      syncState: "ready",
      revision: overrides.revision ?? 1,
      task: overrides.task ?? task,
      events: responseEvents,
      fileLinks: (overrides.fileLinks ?? fileLinks).filter((link) =>
        eventIds.has(link.eventId),
      ),
      eventsPage: { nextCursor: null, ...(overrides.eventsPage ?? {}) },
      pendingApprovals: [],
      ...(overrides.activeTopPlacement
        ? { activeTopPlacement: overrides.activeTopPlacement }
        : {}),
    };
  };
  await page.exposeFunction("__caffoldTaskDetailBootstrap", (requestedThreadId) => {
    if (!task || requestedThreadId !== threadId) {
      return null;
    }
    return detailResponse({
      events: omitCompletedCommandFromDetail
        ? events.filter((event) => event.type !== "command_execution")
        : events,
    });
  });
  const updateTask = (updates) => {
    task = {
      ...task,
      ...updates,
      updatedMs: now + events.length + 1,
      lastEventSummary: updates.lastEventSummary ?? task.lastEventSummary,
    };
  };

  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: contextPath, branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/task-image(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("/tmp/planner-layout.png");
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      expect(url.searchParams.get("cwd")).toBeNull();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection(task ? [task] : [])),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createTaskRequests += 1;
      const body = request.postDataJSON();
      expect(body.cwd).toBe(contextPath);
      expect(body.prompt).toBe("Inspect the planner changes");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("xhigh");
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      task = {
        id: threadId,
        threadId,
        ...canonicalTaskState("active", {
          activeFlags: ["waitingOnApproval"],
          turnId: "turn_1",
          latestTurnStatus: "inProgress",
        }),
        title: "Inspect the planner changes",
        preview: "Inspect the planner changes",
        cwd: contextPath,
        cwdPath: contextPath,
        relativeCwd: "",
        worktree: {
          rootPath: contextPath,
          branch: "main",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          relativeCwd: "",
          linked: false,
        },
        createdMs: now,
        updatedMs: now + 4,
        recencyMs: now + 4,
        lastEventSummary: "Command approval requested",
      };
      events = [
        eventRecord("event_1", "prompt_sent", "Prompt sent", { prompt: body.prompt }, 1),
        eventRecord(
          "event_1_user",
          "user_message",
          "User prompt",
          {
            prompt: "",
            text: [
              "# Files mentioned by the user:",
              "",
              "## planner-layout.png: /tmp/planner-layout.png",
              "",
              "## My request for Codex:",
              body.prompt,
            ].join("\n"),
            turnId: "turn_1",
            content: [
              {
                type: "text",
                text: body.prompt,
              },
              {
                type: "image",
                url: body.images[0],
                name: "planner-layout.png",
              },
              {
                type: "localImage",
                path: "/tmp/planner-layout.png",
                name: "server-reference.png",
              },
            ],
          },
          2,
        ),
        eventRecord(
          "event_2",
          "thread_started",
          "Thread started",
          { threadId },
          3,
        ),
        eventRecord("event_3", "turn_started", "Turn started", { turnId: "turn_1" }, 4),
        eventRecord(
          "event_4",
          "approval_requested",
          "Command approval requested",
          {
            approvalId: "approval_1",
            title: "Command approval requested",
            reason: "Run the test suite",
            command: "cargo test",
            cwd: "src",
            decisions: ["allow", "allowAlways", "deny", "denyAndStop"],
          },
          5,
        ),
      ];

      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          detailResponse({
            activeTopPlacement: {
              section: {
                id: "fixture-section-created-task",
                name: contextPath,
                repository: true,
              },
            },
          }),
        ),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      taskDetailReadRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          detailResponse({
            events: omitCompletedCommandFromDetail
              ? events.filter((event) => event.type !== "command_execution")
              : events,
          }),
        ),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "prompts" &&
      method === "POST"
    ) {
      const body = request.postDataJSON();
      followUpRequests += 1;
      if (body.prompt === "Prompt that fails") {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Prompt request failed" }),
        });
      }
      if (body.prompt === "한글 버튼 제출") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: `turn_${followUpRequests}`,
            steered: body.activeTurnId !== null,
          }),
        });
      }
      if (body.prompt === "Canonical sync unlocks composer") {
        resolveCanonicalFollowUpRequest();
        await canonicalFollowUpResponseReleased;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_canonical_ack",
            steered: false,
          }),
        });
      }
      if (body.prompt === "Enter after canonical sync") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_after_canonical_ack",
            steered: false,
          }),
        });
      }
      expect(body.prompt).toBe("Please tighten the tests");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("ultra");
      expect(body.activeTurnId).toBeNull();
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      resolveFollowUpRequest();
      await followUpResponseReleased;
      events = [
        ...events,
        eventRecord(
          "event_6",
          "prompt_sent",
          "Follow-up prompt sent",
          { prompt: body.prompt },
          13,
        ),
        eventRecord(
          "event_6_user",
          "user_message",
          "User prompt",
          {
            text: body.prompt,
            turnId: "turn_2",
            content: [
              { type: "text", text: body.prompt },
              { type: "image", url: body.images[0], name: "follow-up.png" },
            ],
          },
          14,
        ),
        eventRecord(
          "event_6_turn",
          "turn_started",
          "Turn started",
          { turnId: "turn_2" },
          15,
        ),
        eventRecord(
          "command_follow_up",
          "command_execution",
          "Command inProgress",
          {
            turnId: "turn_2",
            itemId: "command_follow_up",
            command: "cargo test --workspace",
            cwd: "src",
            status: "inProgress",
          },
          16,
        ),
      ];
      updateTask({
        ...canonicalTaskState("active", {
          turnId: "turn_2",
          latestTurnStatus: "inProgress",
        }),
        lastEventSummary: "Command inProgress",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn_2",
          steered: false,
        }),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "interrupt" &&
      method === "POST"
    ) {
      events = [
        ...events,
        eventRecord("event_7", "turn_interrupted", "Interrupt requested", null, 17),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
        lastEventSummary: "Interrupt requested",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === threadId &&
      segments[3] === "approvals" &&
      segments[4] === "approval_1" &&
      method === "POST"
    ) {
      approvalRequests += 1;
      const body = request.postDataJSON();
      expect(body.decision).toBe("allow");
      events = [
        ...events,
        eventRecord(
          "event_5",
          "approval_resolved",
          "Approval resolved: accept",
          { approvalId: "approval_1", outcome: "allow", turnId: "turn_1" },
          5,
        ),
        eventRecord(
          "item-9",
          "assistant_message",
          "Assistant response",
          {
            phase: "progress",
            text: "I am checking the planner diff before the final answer.",
          },
          11,
        ),
        eventRecord(
          "event_8",
          "reasoning",
          "Reasoning summary",
          {
            summary: ["Checked the planner diff.", "Confirmed the fixture coverage path."],
          },
          8,
        ),
        eventRecord(
          "event_9",
          "plan",
          "Plan updated",
          {
            text: "1. Inspect planner behavior\n2. Run focused tests",
          },
          9,
        ),
        eventRecord(
          "event_9_command_live",
          "command_execution",
          "Command started",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "inProgress",
          },
          9,
        ),
        eventRecord(
          "event_9_command",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
            exitCode: 0,
            durationMs: 1_250,
            output:
              "test result: ok. 12 passed.\n" +
              Array.from(
                { length: 80 },
                (_, index) => `output line ${index + 1}: planner fixture completed`,
              ).join("\n") +
              "\n" +
              "command-output-with-an-intentionally-long-unbroken-token-".repeat(18),
          },
          9,
        ),
        eventRecord(
          "event_9_command_failed",
          "command_execution",
          "Command failed",
          {
            turnId: "turn_1",
            itemId: "command_2",
            command: "cargo test --package missing",
            cwd: "src",
            status: "failed",
            exitCode: 101,
            durationMs: 2_400,
            output: "error: package `missing` was not found",
          },
          9,
        ),
        eventRecord(
          "event_10",
          "file_change",
          "File changes: 2",
          {
            status: "completed",
            paths: ["src/planner.rs", "tests/planner.rs"],
          },
          10,
        ),
        eventRecord(
          "event_9_command_completed",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
          },
          11,
        ),
        eventRecord(
          "event_10_repeat",
          "file_change",
          "File changes: 1",
          {
            status: "completed",
            paths: ["src/lib.rs"],
          },
          10,
        ),
        eventRecord(
          "item-10",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_11_duplicate",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_12",
          "turn_completed",
          "Turn completed",
          { turnId: "turn_1", status: "completed" },
          12,
        ),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
        lastEventSummary: "Turn completed",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    return route.fallback();
  });

  const seedCompletedTask = async () => {
    await page.goto("/tasks");
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await page.evaluate(
      async ({ contextPath, image }) => {
        const created = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: contextPath,
            prompt: "Inspect the planner changes",
            model: "gpt-5.6-sol",
            effort: "xhigh",
            permissionMode: "approveForMe",
            images: [image],
          }),
        });
        if (!created.ok) {
          throw new Error(`task seed failed: ${created.status}`);
        }
      },
      { contextPath, image },
    );
    await page.evaluate(async (threadId) => {
      const approved = await fetch(
        `/api/tasks/${threadId}/approvals/approval_1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "allow" }),
        },
      );
      if (!approved.ok) {
        throw new Error(`approval seed failed: ${approved.status}`);
      }
    }, threadId);
  };

  return {
    contextPath,
    threadId,
    now,
    pageErrors,
    followUpRequested,
    releaseFollowUpResponse,
    canonicalFollowUpRequested,
    releaseCanonicalFollowUpResponse,
    eventRecord,
    detailResponse,
    updateTask,
    seedCompletedTask,
    get task() {
      return task;
    },
    get events() {
      return events;
    },
    set events(value) {
      events = value;
    },
    get createTaskRequests() {
      return createTaskRequests;
    },
    get followUpRequests() {
      return followUpRequests;
    },
    get taskDetailReadRequests() {
      return taskDetailReadRequests;
    },
    get approvalRequests() {
      return approvalRequests;
    },
    set omitCompletedCommandFromDetail(value) {
      omitCompletedCommandFromDetail = value;
    },
  };
}
