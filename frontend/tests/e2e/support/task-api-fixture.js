import {
  installExternalModuleDefaults,
  mockCodexStatus,
} from "./browser-defaults.js";
import { activeTaskProjection } from "./task-fixtures.js";
import { installTaskSseControllerInBrowser } from "./task-sse-fixture.js";

export const TASK_PERMISSION_FIXTURE = {
  defaultMode: "approveForMe",
  options: [
    {
      mode: "askForApproval",
      label: "Ask for approval",
      description: "Work in the workspace and ask before crossing its boundary.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "approveForMe",
      label: "Approve for me",
      description: "Keep the workspace boundary and review eligible requests automatically.",
      allowed: true,
      dangerous: false,
    },
    {
      mode: "fullAccess",
      label: "Full access",
      description: "Run without sandbox restrictions or approval prompts.",
      allowed: true,
      dangerous: true,
    },
  ],
};

export async function installTaskApiFixture(page, overrides = {}) {
  await installExternalModuleDefaults(page);
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    }),
  );
  await page.addInitScript(installTaskSseControllerInBrowser);
  await page.addInitScript((fixtureOptions) => {
    window.__taskPermissionEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        this.detailAvailabilityKey = fixtureOptions.detailAvailabilityKey;
        window.__taskPermissionEventSources.push(this);
        window.__caffoldRegisterTaskSseSource(this);
        if (url.includes("/api/tasks/thread-1/stream")) {
          window.__taskDetailSource = this;
        } else if (url.startsWith("/api/tasks/stream")) {
          window.__taskListSource = this;
        }
        queueMicrotask(() => this.emitOpen());
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

      close() {
        this.readyState = 2;
      }
    };
  }, {
    detailAvailabilityKey: overrides.detailAvailabilityKey ?? null,
  });
  await page.route("**/api/agent/permissions*", (route) =>
    route.fulfill({ json: overrides.permissions ?? TASK_PERMISSION_FIXTURE }),
  );
  await page.route("**/api/agent/models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            provider: "codex",
            model: "gpt-test",
            displayName: "GPT Test",
            description: "Test model",
            isDefault: true,
            defaultEffort: "medium",
            efforts: ["medium", "xhigh"],
            supportsFastMode: true,
          },
        ],
        unavailable: [],
      },
    }),
  );
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ json: activeTaskProjection() }),
  );
  await page.route("**/api/tasks/*/prompts", (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: {
        threadId,
        turnId: "turn-created-1",
        userMessageId: "message-created-1",
        steered: false,
      },
    });
  });
  await page.route("**/api/tasks/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": ready\n\n",
    }),
  );
}

export function taskDetailFixture({
  running = false,
  model = null,
  reasoningEffort = null,
  fastMode = false,
} = {}) {
  return {
    provider: "codex",
    threadId: "thread-1",
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task: {
      id: "thread-1",
      threadId: "thread-1",
      title: running ? "Running task" : "New task",
      preview: running ? "Working" : "Ready",
      threadStatus: { type: running ? "active" : "idle", activeFlags: [] },
      latestTurnStatus: running ? "inProgress" : null,
      activeTurn: running ? { id: "turn-1", startedAtMs: 1 } : null,
      cwd: "src",
      cwdPath: "src",
      relativeCwd: ".",
      worktree: null,
      createdMs: 1,
      updatedMs: 2,
      recencyMs: 2,
      lastEventSummary: null,
      unseen: false,
    },
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
    model,
    reasoningEffort,
    fastMode,
  };
}
