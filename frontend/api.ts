import { reportOriginReachable } from "./origin-reachability.js";

// The limit for requests that recovery and live updates wait on. On a slow
// link their answers queue behind a large live update; whether the link still
// delivers is the live connection's call, so this ends only a request that
// never answers.
const SLOW_LINK_TIMEOUT_MS = 30_000;

export async function getHealth() {
  return requestJson<Health>("/api/health");
}

/** The server may ask GitHub first, which it bounds at eight seconds. */
export async function getCaffoldUpdate() {
  return requestJson<CaffoldUpdateStatus>(
    "/api/caffold/update",
    {},
    { timeoutMs: 20_000 },
  );
}

/** Has the server ask GitHub now, and answers as `getCaffoldUpdate` does. */
export async function checkCaffoldUpdate() {
  return requestJson<CaffoldUpdateStatus>(
    "/api/caffold/update/check",
    {},
    {
      method: "POST",
      timeoutMs: 20_000,
    },
  );
}

/** Hands the server foreground recovery diagnostics, for its log. */
export async function sendForegroundRecoveryDiagnostics(records: unknown[]) {
  return requestJson(
    "/api/diagnostics/foreground-recovery",
    {},
    {
      method: "POST",
      body: { records },
    },
  );
}

export async function getCodexStatus() {
  return requestJson<CodexStatus>("/api/codex/status");
}

/** What the server last found about Codex, without a check of its own. */
export async function getCodexReadiness() {
  return requestJson<{ readiness?: CodexReadiness | null }>(
    "/api/codex/readiness",
  );
}

export async function consumeCodexResetCredit({
  creditId = null,
  idempotencyKey,
}: {
  creditId?: string | null;
  idempotencyKey: string;
}) {
  return requestJson<{ outcome: CodexResetCreditOutcome }>(
    "/api/codex/reset-credits/consume",
    {},
    {
      method: "POST",
      body: { creditId, idempotencyKey },
    },
  );
}

export async function getCodexMcpDiagnostics() {
  return requestJson<CodexMcpDiagnostics>(
    "/api/codex/mcp-diagnostics",
    {},
    { timeoutMs: 10_000 },
  );
}

export async function getClaudeStatus() {
  return requestJson<ClaudeStatus>("/api/claude/status");
}

export async function getGrokStatus() {
  return requestJson<GrokStatus>("/api/grok/status");
}

// Restarts the Claude runner; its conversations resume as their Tasks open.
export async function restartClaudeRuntime() {
  return requestJson("/api/claude/restart", {}, { method: "POST" });
}

export async function restartCodexRuntime() {
  return requestJson("/api/codex/restart", {}, { method: "POST" });
}

export async function getCodexUpdates() {
  return requestJson<CodexUpdates>(
    "/api/codex/updates",
    {},
    { timeoutMs: 20_000 },
  );
}

/** The backend bounds this at ten minutes: download, drain, and restart. */
export async function updateCodexRuntime() {
  return requestJson<CodexUpdateOutcome>(
    "/api/codex/update",
    {},
    { method: "POST" },
  );
}

export async function getTaskStoreStatus() {
  return requestJson<TaskStoreReadiness>(
    "/api/task-store/status",
    {},
    {
      timeoutMs: SLOW_LINK_TIMEOUT_MS,
    },
  );
}

export async function retryTaskStoreMigration() {
  return requestJson(
    "/api/task-store/migration/retry",
    {},
    {
      method: "POST",
    },
  );
}

export async function getAgentModels() {
  return requestJson<AgentModels>("/api/agent/models");
}

export async function getAgentPermissions(cwd = "", provider = "", model = "") {
  const query: Record<string, string> = {};
  if (cwd) {
    query.cwd = cwd;
  }
  if (provider) {
    query.provider = provider;
  }
  if (model) {
    query.model = model;
  }
  return requestJson<AgentPermissionModes>("/api/agent/permissions", query);
}

export async function getVoiceStatus() {
  return requestJson<VoiceStatus>("/api/voice/status");
}

// The Tailscale, Voice, and Jev answers are checked by the lifecycle that
// asked for them.
export async function getTailscaleStatus() {
  return requestJson("/api/tailscale/status");
}

export async function setTailscaleServe(enabled: boolean) {
  return requestJson(
    "/api/tailscale/serve",
    {},
    {
      method: "PUT",
      body: { enabled },
    },
  );
}

export async function getPushConfig() {
  return requestJson<{ publicKey: string }>("/api/push/config");
}

export async function getPushInstallations(clientId: string) {
  return requestJson<{
    currentState: string;
    installations?: PushInstallation[];
  }>("/api/push/installations", { clientId });
}

export async function upsertPushInstallation(
  clientId: string,
  subscription: PushSubscriptionPayload,
) {
  return requestJson<PushInstallation>(
    `/api/push/installations/${encodeURIComponent(clientId)}`,
    {},
    { method: "PUT", body: subscription },
  );
}

export async function removePushInstallation(clientId: string) {
  return requestJson(
    `/api/push/installations/${encodeURIComponent(clientId)}`,
    {},
    { method: "DELETE", expectJson: false },
  );
}

export async function getVoiceSettings() {
  return requestJson("/api/voice/settings");
}

export async function selectVoiceProvider(provider: string) {
  return requestJson(
    "/api/voice/provider",
    {},
    {
      method: "PUT",
      body: { provider },
    },
  );
}

export async function startVoiceModelDownload() {
  return requestJson("/api/voice/model/install", {}, { method: "POST" });
}

export async function removeVoiceModel() {
  return requestJson("/api/voice/model", {}, { method: "DELETE" });
}

export async function storeVoiceKey(provider: string, key: string) {
  return requestJson(
    `/api/voice/keys/${encodeURIComponent(provider)}`,
    {},
    {
      method: "PUT",
      body: { key },
    },
  );
}

export async function removeVoiceKey(provider: string) {
  return requestJson(
    `/api/voice/keys/${encodeURIComponent(provider)}`,
    {},
    {
      method: "DELETE",
    },
  );
}

export async function getJevSettings() {
  return requestJson("/api/jev/settings");
}

export async function saveJevCriteria(criteria: string) {
  return requestJson(
    "/api/jev/criteria",
    {},
    {
      method: "PUT",
      body: { criteria },
    },
  );
}

export async function storeJevKey(key: string) {
  return requestJson(
    "/api/jev/key",
    {},
    {
      method: "PUT",
      body: { key },
    },
  );
}

export async function removeJevKey() {
  return requestJson("/api/jev/key", {}, { method: "DELETE" });
}

// What a Task's own prompts settled about what it may do, as one text.
export async function getTaskPermissionInstructions(threadId: string) {
  return requestJson<{ instructions?: string | null }>(
    `/api/tasks/${encodeURIComponent(threadId)}/permission-instructions`,
  );
}

export async function forgetTaskPermissionInstructions(threadId: string) {
  return requestJson<{ instructions?: string | null }>(
    `/api/tasks/${encodeURIComponent(threadId)}/permission-instructions`,
    {},
    { method: "DELETE" },
  );
}

export async function transcribeVoice(recording: Blob, signal?: AbortSignal) {
  return requestJson<VoiceTranscript>(
    "/api/voice/transcribe",
    {},
    {
      method: "POST",
      rawBody: recording,
      contentType: "audio/wav",
      signal,
    },
  );
}

export async function getTasks() {
  return requestJson<{
    sections: ActiveTaskSection[];
    unsectioned: ActiveTaskRecovery[];
  }>("/api/tasks", {}, { timeoutMs: SLOW_LINK_TIMEOUT_MS });
}

export async function getArchivedTasks(cursor: string | null = null) {
  return requestJson<{ tasks: Task[]; nextCursor: string | null }>(
    "/api/tasks/archived",
    {
      ...(cursor ? { cursor } : {}),
    },
  );
}

export async function markTaskSeen(threadId: string) {
  return requestJson<Task>(
    `/api/tasks/${encodeURIComponent(threadId)}/seen`,
    {},
    {
      method: "PUT",
    },
  );
}

export async function reorderTask(
  threadId: string,
  beforeThreadId: string | null,
) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/reorder`,
    {},
    {
      method: "POST",
      body: { beforeThreadId: beforeThreadId ?? null },
    },
  );
}

export async function reorderSection(
  sectionId: string,
  beforeSectionId: string | null,
) {
  return requestJson(
    `/api/tasks/sections/${encodeURIComponent(sectionId)}/reorder`,
    {},
    {
      method: "POST",
      body: { beforeSectionId: beforeSectionId ?? null },
    },
  );
}

export async function archiveTask(threadId: string) {
  return requestJson<Task>(
    `/api/tasks/${encodeURIComponent(threadId)}/archive`,
    {},
    {
      method: "POST",
    },
  );
}

// A new Task that starts from this one's conversation.
export async function forkTask(threadId: string) {
  return requestJson<CreatedTask>(
    `/api/tasks/${encodeURIComponent(threadId)}/fork`,
    {},
    {
      method: "POST",
    },
  );
}

export async function previewTaskForkSource(
  source: { provider: string; sourceId: string },
  signal?: AbortSignal,
) {
  return requestJson<TaskForkSourcePreview>(
    "/api/task-forks/preview",
    {},
    {
      method: "POST",
      body: source,
      signal,
    },
  );
}

// A new Task in a Section that starts from another conversation of an agent.
export async function createTaskFork(fork: {
  provider: string;
  sourceId: string;
  sectionId: string;
}) {
  return requestJson<CreatedTask>(
    "/api/task-forks",
    {},
    {
      method: "POST",
      body: fork,
    },
  );
}

export async function restoreTask(threadId: string) {
  return requestJson<{
    task: ActiveTask;
    activeTopPlacement: ActiveTaskTopPlacement;
  }>(
    `/api/tasks/${encodeURIComponent(threadId)}/restore`,
    {},
    {
      method: "POST",
    },
  );
}

// What a Task that needs recovery can do: go back to Active, be checked
// again, move to Archived, or leave Caffold.
export async function restoreRecoveryTask(threadId: string) {
  return requestJson<{
    task: ActiveTask;
    activeTopPlacement: ActiveTaskTopPlacement;
  }>(
    `/api/tasks/${encodeURIComponent(threadId)}/recovery/restore`,
    {},
    { method: "POST" },
  );
}

export async function recheckRecoveryTask(threadId: string) {
  return requestJson<ActiveTaskRecovery>(
    `/api/tasks/${encodeURIComponent(threadId)}/recovery/recheck`,
    {},
    { method: "POST" },
  );
}

export async function archiveRecoveryTask(threadId: string) {
  return requestJson<Task>(
    `/api/tasks/${encodeURIComponent(threadId)}/recovery/archive`,
    {},
    { method: "POST" },
  );
}

export async function removeRecoveryTask(threadId: string) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/recovery/remove`,
    {},
    { method: "POST" },
  );
}

// A Task whose worktree is broken is deleted only with the worktree its
// diagnosis named.
export async function deleteTask(
  threadId: string,
  confirmation: {
    confirmBrokenWorktreeDeletion: boolean;
    expectedWorktreeId: string;
  } | null = null,
) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}`,
    {},
    {
      method: "DELETE",
      ...(confirmation ? { body: confirmation } : {}),
    },
  );
}

export async function createTask(task: Record<string, unknown>) {
  return requestJson<CreatedTask>(
    "/api/tasks",
    {},
    {
      method: "POST",
      body: task,
    },
  );
}

export async function getTask(
  threadId: string,
  cursor: string | null = null,
  { signal }: { signal?: AbortSignal } = {},
) {
  return requestJson<TaskDetail>(
    `/api/tasks/${encodeURIComponent(threadId)}`,
    { cursor },
    { signal },
  );
}

// A prompt for a Task's agent. The answer names the user message it became
// and says whether it steered the running turn instead of starting one.
export async function sendTaskPrompt(
  threadId: string,
  prompt: string,
  options: Record<string, unknown> = {},
  imagePaths: string[] = [],
) {
  return requestJson<{
    threadId: string;
    userMessageId: string;
    steered: boolean;
  }>(
    `/api/tasks/${encodeURIComponent(threadId)}/prompts`,
    {},
    {
      method: "POST",
      body: { prompt, imagePaths, ...options },
    },
  );
}

// One file a prompt carries, into that send's upload folder. XMLHttpRequest
// rather than fetch, because only it reports how much of a request body has
// gone out.
export function uploadTaskFile(
  threadId: string,
  folder: string,
  name: string,
  file: Blob,
  {
    onProgress,
    signal,
  }: { onProgress?: (loaded: number) => void; signal?: AbortSignal } = {},
) {
  return new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) {
      reject(uploadCancelled());
      return;
    }
    const request = new XMLHttpRequest();
    const cancel = () => request.abort();
    const settle = (finish: () => void) => {
      signal?.removeEventListener("abort", cancel);
      finish();
    };
    request.open(
      "PUT",
      `/api/tasks/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`,
    );
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      onProgress?.(event.loaded);
    });
    request.addEventListener("load", () =>
      settle(() => {
        reportOriginReachable();
        const payload = parseJson(request.responseText);
        if (request.status >= 200 && request.status < 300) {
          resolve(payload);
        } else {
          reject(responseError(payload, request.status));
        }
      }),
    );
    request.addEventListener("error", () =>
      settle(() => {
        reject(
          Object.assign(
            new Error(`Could not reach Caffold to upload ${name}.`),
            {
              code: "upload_unreachable",
              status: 0,
            },
          ),
        );
      }),
    );
    request.addEventListener("abort", () =>
      settle(() => reject(uploadCancelled())),
    );
    signal?.addEventListener("abort", cancel, { once: true });
    request.send(file);
  });
}

export async function discardTaskUploads(threadId: string, folder: string) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(folder)}`,
    {},
    { method: "DELETE", expectJson: false },
  );
}

// Stops the running turn. The prompts the stop cancelled before the agent
// took them in come back to be sent again.
export async function interruptTask(threadId: string) {
  return requestJson<
    TaskDetail & { cancelledPrompts: Array<{ prompt: string }> }
  >(
    `/api/tasks/${encodeURIComponent(threadId)}/interrupt`,
    {},
    {
      method: "POST",
    },
  );
}

export async function resolveTaskApproval(
  threadId: string,
  approvalId: string,
  decision: string,
) {
  return requestJson<TaskDetail>(
    `/api/tasks/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(approvalId)}`,
    {},
    {
      method: "POST",
      body: { decision },
    },
  );
}

export function liveUpdatesUrl() {
  const url = new URL("/api/live", window.location.origin);
  return `${url.pathname}${url.search}`;
}

export async function updateLiveSubscriptions(
  connectionId: string,
  subscriptions: unknown,
) {
  return requestJson(
    `/api/live/${encodeURIComponent(connectionId)}/subscriptions`,
    {},
    {
      method: "PUT",
      body: subscriptions,
      expectJson: false,
      timeoutMs: SLOW_LINK_TIMEOUT_MS,
    },
  );
}

// A terminal belongs to one Task or one Section. Starts the subject's shell at
// the given size.
export async function openTerminal({
  subject,
  cwd,
  cols,
  rows,
}: {
  subject: TerminalSubject;
  cwd: string;
  cols: number;
  rows: number;
}) {
  return requestJson(
    "/api/terminal",
    {},
    {
      method: "POST",
      body: { ...terminalSubjectFields(subject), cwd, cols, rows },
      expectJson: false,
    },
  );
}

export async function killTerminal(subject: TerminalSubject) {
  return requestJson("/api/terminal", terminalSubjectFields(subject), {
    method: "DELETE",
    expectJson: false,
  });
}

// Where a screen attaches to the subject's terminal: `take` to be its one
// screen, `resume` only if it already was; `tab` names the browser tab.
export function terminalSocketUrl(
  subject: TerminalSubject,
  {
    mode,
    tab,
    cols,
    rows,
  }: { mode: string; tab: string; cols: number; rows: number },
) {
  const url = new URL("/api/terminal/socket", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries({
    ...terminalSubjectFields(subject),
    mode,
    tab,
    cols,
    rows,
  })) {
    url.searchParams.set(key, `${value}`);
  }
  return url.href;
}

function terminalSubjectFields(subject: TerminalSubject | null | undefined) {
  return subject?.kind === "section"
    ? { section: `${subject.id ?? ""}` }
    : { task: `${subject?.id ?? ""}` };
}

export async function listDirectory(path = "") {
  return requestJson<DirectoryListing>(
    "/api/list",
    { path },
    { timeoutMs: 7000 },
  );
}

export async function readFile(path: string, signal?: AbortSignal) {
  return requestJson<FileContent>("/api/file", { path }, { signal });
}

export async function getNotes(directoryId: string, signal?: AbortSignal) {
  return requestJson<NotesLevel>(
    "/api/notes",
    { directoryId: directoryId || undefined },
    { signal },
  );
}

export async function getNote(noteId: string, signal?: AbortSignal) {
  return requestJson<Note>(
    `/api/notes/${encodeURIComponent(noteId)}`,
    {},
    { signal },
  );
}

// A Task's current plan as the server reads it from the Task's folder; the
// Current Plan checks its shape.
export async function getCurrentPlan(path = "", signal?: AbortSignal) {
  return requestJson(
    "/api/current-plan",
    { path },
    {
      signal,
      timeoutMs: SLOW_LINK_TIMEOUT_MS,
    },
  );
}

export function imageUrl(path: string) {
  const url = new URL("/api/image", window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

export function documentUrl(path: string) {
  const url = new URL("/api/document", window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

export function downloadUrl(path: string) {
  const url = new URL("/api/download", window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

export async function getGitStatus(path = "") {
  return requestJson<GitStatus>("/api/git/status", { path });
}

export async function getGitDiff(path = "", file: string, kind = "unstaged") {
  return requestJson<GitDiff>("/api/git/diff", { path, file, kind });
}

export async function getGitLog(path = "", page = 1, perPage = 50) {
  return requestJson<GitLog>("/api/git/log", { path, page, perPage });
}

export async function fetchGitRemote(path = "") {
  return requestJson<GitFetchResult>(
    "/api/git/fetch",
    {},
    {
      method: "POST",
      body: { path },
    },
  );
}

export async function getGitCommit(path = "", sha: string) {
  return requestJson<GitCommit>("/api/git/commit", { path, sha });
}

export async function getGitCommitDiff(path = "", sha: string, file: string) {
  return requestJson<GitDiff>("/api/git/commit-diff", { path, sha, file });
}

export async function getGitCompare(
  path = "",
  base: string | null = null,
  head: string | null = null,
) {
  return requestJson<GitCompare>("/api/git/compare", { path, base, head });
}

export async function getGitRefs(path = "") {
  return requestJson<GitRefs>("/api/git/refs", { path });
}

export async function getGitCompareDiff(
  path = "",
  base: string | null = null,
  head: string | null = null,
  file: string,
) {
  return requestJson<GitDiff>("/api/git/compare-diff", {
    path,
    base,
    head,
    file,
  });
}

export async function getGitHubStatus(path = "") {
  return requestJson<GitHubStatus>("/api/github/status", { path });
}

export async function getGitHubIssues(
  path = "",
  state = "open",
  page = 1,
  perPage = 50,
) {
  return requestJson<GitHubIssues>("/api/github/issues", {
    path,
    state,
    page,
    perPage,
  });
}

export async function getGitHubIssue(path = "", number: number) {
  return requestJson<GitHubIssue>("/api/github/issue", { path, number });
}

export async function getGitHubPulls(
  path = "",
  state = "open",
  page = 1,
  perPage = 50,
) {
  return requestJson<GitHubPulls>("/api/github/pulls", {
    path,
    state,
    page,
    perPage,
  });
}

export async function getGitHubPull(path = "", number: number) {
  return requestJson<GitHubPull>("/api/github/pull", { path, number });
}

export async function prepareGitHubPullHead(
  path = "",
  number: number,
  headOid: string,
  baseRepository: string,
) {
  return requestJson<GitHubPullHead>(
    "/api/github/pull-head",
    {},
    {
      method: "POST",
      body: { path, number, headOid, baseRepository },
    },
  );
}

export async function getGitHubPullFiles(path = "", number: number) {
  return requestJson<GitHubPullFiles>("/api/github/pull-files", {
    path,
    number,
  });
}

export async function getGitHubPullFile(
  path = "",
  number: number,
  file: string,
) {
  return requestJson<GitHubPullFileDiff>("/api/github/pull-file", {
    path,
    number,
    file,
  });
}

// How one request goes out: its method, a deadline, a caller's cancel, the
// body as JSON or raw bytes, and whether its answer is read.
interface RequestOptions {
  method?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  expectJson?: boolean;
}

async function requestJson<T = unknown>(
  endpoint: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(endpoint, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const fetchOptions: RequestInit = {
    method: options.method ?? "GET",
  };
  const controller = options.timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timeoutId = controller
    ? window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs)
    : null;
  const forwardAbort = () => controller?.abort();
  if (controller && options.signal) {
    if (options.signal.aborted) {
      forwardAbort();
    } else {
      options.signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  if (options.signal || controller) {
    fetchOptions.signal = controller?.signal ?? options.signal;
  }

  if (options.rawBody !== undefined) {
    fetchOptions.headers = {
      "content-type": options.contentType ?? "application/octet-stream",
    };
    fetchOptions.body = options.rawBody;
  } else if (options.body !== undefined) {
    fetchOptions.headers = {
      "content-type": "application/json",
    };
    fetchOptions.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error("Request timed out."), {
        code: "request_timeout",
        status: 0,
      });
    }

    throw error;
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  reportOriginReachable();
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw responseError(payload, response.status);
  }

  if (options.expectJson === false) {
    return null as T;
  }

  return payload as T;
}

// Why the Task a request named is not there to answer it. A deleted Task
// leaves no record, so it reads as one Caffold cannot find.
export const TASK_ABSENCE = Object.freeze({
  ARCHIVED: "archived",
  NOT_FOUND: "not-found",
});

export type TaskAbsence = (typeof TASK_ABSENCE)[keyof typeof TASK_ABSENCE];

// The absence a failed Task request or a refused Task channel reports, or null
// for any other failure.
export function taskAbsence(error: unknown): TaskAbsence | null {
  switch ((error as { code?: unknown } | null)?.code) {
    case "task_archived":
      return TASK_ABSENCE.ARCHIVED;
    case "task_not_found":
      return TASK_ABSENCE.NOT_FOUND;
    default:
      return null;
  }
}

// A Restore refused because the Task is active already, restored elsewhere.
export function taskAlreadyActive(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "task_not_archived";
}

// An error from a reported Task failure: an error as it is, or the API's error
// body with what it says the Task still allows.
export function taskResponseError(
  value: unknown,
  fallback = "Task details are temporarily unavailable.",
): TaskResponseError {
  if (value instanceof Error) return value;
  const body = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const error: TaskResponseError = new Error(
    (body.message ?? (typeof value === "string" ? value : fallback)) as string,
  );
  for (const key of [
    "code",
    "allowedActions",
    "worktreeId",
    "worktreePath",
    "worktreeMissing",
  ]) {
    if (body[key] !== undefined) {
      (error as unknown as Record<string, unknown>)[key] = body[key];
    }
  }
  return error;
}

function responseError(payload: unknown, status: number) {
  const reported = (payload as { error?: { code?: string } } | null)?.error;
  const error = taskResponseError(
    reported,
    `Request failed with HTTP ${status}`,
  );
  error.code = reported?.code ?? "request_failed";
  error.status = status;
  return error;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function uploadCancelled() {
  const error: TaskResponseError = new Error("The upload was cancelled.");
  error.name = "AbortError";
  error.code = "upload_cancelled";
  error.status = 0;
  return error;
}

// The server colors source text and sends each line's spans as
// `[start, length, color]` in UTF-16 units. The color numbers follow
// `SyntaxColor` in caffold/src/fs/syntax.rs.
export type SyntaxSpan = [start: number, length: number, color: number];

export interface GitRepository {
  rootPath?: string;
  root?: string;
  path?: string;
  branch?: string | null;
  dirty?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: string;
  isSymlink?: boolean;
  supported: boolean;
  gitIgnored?: boolean;
  size?: number | null;
  modifiedMs?: number | null;
  git?: { isRepoRoot?: boolean } | null;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  git?: { rootPath: string; branch?: string | null; dirty?: boolean } | null;
}

export interface GitRef {
  name: string;
  kind?: string;
}

export interface GitRefs {
  repository: GitRepository;
  refs: GitRef[];
  currentRef?: string | null;
  defaultBaseRef?: string | null;
  defaultHeadRef?: string | null;
}

export interface GitCompareFile {
  path: string;
  repoRelativePath: string;
  status?: string;
}

export interface GitCompare {
  repository: GitRepository;
  baseRef: string | null;
  headRef: string | null;
  files?: GitCompareFile[];
  additions?: number;
  deletions?: number;
}

// A file's diff in the Working Tree, a commit, or a comparison.
export interface GitDiff {
  path?: string;
  repoRelativePath?: string;
  repository?: GitRepository | null;
  kind?: string;
  diff?: string;
  syntaxSpans?: Array<SyntaxSpan[] | null> | null;
  additions?: number;
  deletions?: number;
}

export interface GitChangedFile {
  path: string;
  repoRelativePath: string;
  status: string;
  category: "staged" | "unstaged" | "untracked";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  repository: GitRepository;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorTimeMs: number;
}

export interface GitCommitFile {
  path: string;
  repoRelativePath: string;
  status: string;
}

export interface GitCommit {
  repository: GitRepository;
  commit: GitCommitSummary;
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}

export interface GitLog {
  repository: GitRepository;
  commits: GitCommitSummary[];
  page: number;
  perPage: number;
  totalCommits: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitFetchResult {
  repository: GitRepository;
  remote: string;
  branch: string;
  reference: string;
  ahead: number;
  behind: number;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedMs: number | null;
  language: string;
  content: string;
  syntaxSpans: Array<SyntaxSpan[] | null> | null;
}

// The models the agents offer, and the agents that could not be asked.
export interface AgentModels {
  models: AgentModel[];
  unavailable: Array<{ provider: string; message: string }>;
}

export interface AgentModel {
  provider: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: string | null;
  efforts: string[];
  supportsFastMode: boolean;
}

// The ways an agent lets a model work in a directory, as the agent offers
// them.
export interface AgentPermissionModes {
  defaultMode: string;
  options: AgentPermissionMode[];
  fixedWhenConversationStarts: boolean;
}

export interface AgentPermissionMode {
  mode: string;
  label: string;
  description: string;
  allowed: boolean;
  unavailableReason?: string;
  dangerous: boolean;
}

export interface GitHubRepositoryInfo {
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
}

export interface GitHubStatus {
  repository: GitRepository | null;
  github: GitHubRepositoryInfo | null;
  ghAvailable: boolean;
  authenticated: boolean;
  issuesAvailable: boolean;
  pullsAvailable: boolean;
  message: string | null;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  updatedAt: string | null;
  url: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
}

export interface GitHubIssues {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  state: string;
  issues: GitHubIssueSummary[];
  page: number;
  perPage: number;
  totalIssues: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitHubIssue {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  issue: GitHubIssueDetail;
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  labels: string[];
  comments: number;
  updatedAt: string | null;
  url: string;
}

export interface GitHubPullRepositoryInfo {
  nameWithOwner: string;
  url: string;
}

export interface GitHubPullComment {
  author: string | null;
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

export interface GitHubPullReview {
  author: string | null;
  state: string;
  body: string;
  bodyHtml: string | null;
  submittedAt: string | null;
}

export interface GitHubPullCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string | null;
  authorEmail: string | null;
  authoredAt: string | null;
  committedAt: string | null;
  url: string;
}

export interface GitHubPullDetail extends GitHubPullSummary {
  reviews: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  baseRefOid: string;
  baseRepository: GitHubPullRepositoryInfo;
  headRefName: string;
  headRefOid: string;
  headRepository: GitHubPullRepositoryInfo | null;
  body: string;
  bodyHtml: string | null;
  createdAt: string | null;
  conversationComments: GitHubPullComment[];
  reviewComments: GitHubPullReview[];
  commitSummaries: GitHubPullCommit[];
}

export interface GitHubPulls {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  state: string;
  pulls: GitHubPullSummary[];
  page: number;
  perPage: number;
  totalPulls: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface GitHubPull {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  pull: GitHubPullDetail;
}

export interface GitHubPullHead {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  headRef: string;
  headOid: string;
}

export interface GitHubPullFile {
  path: string;
  repoRelativePath: string;
  previousPath: string | null;
  previousRepoRelativePath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patchAvailable: boolean;
  blobUrl: string | null;
  rawUrl: string | null;
}

export interface GitHubPullFiles {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  files: GitHubPullFile[];
  totalFiles: number;
}

export interface GitHubPullFileDiff {
  repository: GitRepository;
  github: GitHubRepositoryInfo;
  number: number;
  path: string;
  repoRelativePath: string;
  status: string;
  kind: string;
  additions: number | null;
  deletions: number | null;
  diff: string;
  diffUnavailable: boolean;
  message: string | null;
}

// A Task as the Task API reports it, as far as TypeScript callers read it.
export interface Task {
  threadId: string;
  conversationAvailable: boolean;
  title: string;
  threadStatus: TaskThreadStatus;
  activeTurn: { id: string; startedAtMs: number | null } | null;
  cwd: string;
  cwdPath: string | null;
  relativeCwd: string;
  worktree: TaskWorktree | null;
  createdMs: number;
  updatedMs: number;
  recencyMs: number | null;
  lastCompletedMs: number | null;
  unseen: boolean;
}

// What the agent is doing for a Task. An active Task with no flags is working.
export type TaskThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | {
      type: "active";
      activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
    };

// The worktree a Task runs in, when it runs in one.
export interface TaskWorktree {
  rootPath: string;
  repositoryRootPath: string;
  branch: string | null;
  headSha: string;
  relativeCwd: string;
  linked: boolean;
}

// A Task as the Active list shows it. `worktree` says whether it runs in a
// worktree Caffold made for it.
export interface ActiveTask {
  threadId: string;
  title: string;
  threadStatus: TaskThreadStatus;
  unseen: boolean;
  lastCompletedMs: number | null;
  recencyMs: number | null;
  updatedMs: number;
  worktree: boolean;
}

// A listed Task that cannot sit in a Section until the person recovers it.
export interface ActiveTaskRecovery extends ActiveTask {
  recovery: {
    reason:
      | "sectionPlacementPending"
      | "codexArchived"
      | "threadMissing"
      | "temporarilyUnavailable";
    actions: Array<
      "recheck" | "restoreToActive" | "moveToArchived" | "removeFromCaffold"
    >;
  };
}

// What a Section's Tasks last ran under.
export interface ActiveTaskComposerSettings {
  model: string | null;
  effort: string | null;
  fastMode: boolean;
  permissionMode?: string;
}

export interface ActiveTaskSection {
  id: string;
  name: string;
  repository: boolean;
  composerSettings: ActiveTaskComposerSettings | null;
  tasks: ActiveTask[];
}

// Where a Task newly at the top of the Active list goes.
export interface ActiveTaskTopPlacement {
  section: { id: string; name: string; repository: boolean };
  beforeSectionId: string | null;
  beforeThreadId?: string;
}

// A Task request's failure as the API reports it. A Task whose worktree is
// broken also says what may still be done with it and which worktree that is.
export interface TaskResponseError extends Error {
  code?: string;
  status?: number;
  allowedActions?: string[];
  worktreeId?: string;
  worktreePath?: string;
  worktreeMissing?: boolean;
}

// Where an item sits in its conversation: its turn's anchor and its place in
// that turn.
export interface TaskEventPosition {
  anchorMs: number;
  index: number;
}

// The extent of a conversation a Task detail answers for. An open end reaches
// that end of the conversation.
export interface TaskEventsRange {
  from?: TaskEventPosition | null;
  to?: TaskEventPosition | null;
}

// A Task with its conversation, as the Task API and the Task's stream report
// it: the Task, a page of its items and the extent they cover, the
// publication revision they carry, and what its next turn runs under.
export interface TaskDetail {
  threadId?: string;
  task: Task | null;
  events?: TaskEvent[];
  fileLinks?: TaskFileLink[];
  revision?: number;
  eventRevision?: number;
  eventsRange?: TaskEventsRange | null;
  eventsPage?: { nextCursor?: string | null } | null;
  historyLoading?: boolean;
  syncState?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  context?: TaskContextUsage | null;
}

// How much of the model's context the conversation takes up now, and how
// much the model holds.
export interface TaskContextUsage {
  usedTokens: number;
  windowTokens: number;
}

// A Task just made: its detail, the Active list's listing of it, and where it
// goes at the top of that list.
export interface CreatedTask {
  detail: TaskDetail;
  activeTask: ActiveTask;
  activeTopPlacement: ActiveTaskTopPlacement;
}

// An agent's conversation a new Task can start from: its name and summary,
// its status, the project it ran in, when it was last active, and its recent
// messages.
export interface TaskForkSourcePreview {
  provider: string;
  sourceId: string;
  displayName: string;
  summary: string | null;
  status: TaskThreadStatus;
  cwd: string | null;
  lastActivityMs: number | null;
  recentHistory: Array<{ role: string; text: string }>;
}

// One conversation item as a Task's detail and its stream deliver it. The
// backend gives its identity, its place in the conversation, and the time it
// was observed; `payload` carries what each kind of item says. The Task screen
// adds `fileLinks` to a message whose file references resolved.
export interface TaskEvent {
  id: string;
  threadId: string;
  type: string;
  summary: string;
  payload: TaskEventPayload | null;
  position: { anchorMs: number; index: number };
  observedMs: number | null;
  fileLinks?: TaskFileLink[];
}

// A file reference in an agent's message and the file it resolved to in the
// Task.
export interface TaskFileLink {
  target: string;
  taskRelativePath: string;
  line?: number;
  // The item it was found in, as a Task detail lists its links.
  eventId?: string;
}

export interface TaskEventPayload {
  itemId?: string;
  turnId?: string | null;
  threadId?: string;
  // A prompt this browser sent that the agent's history does not hold yet.
  optimistic?: boolean;
  submissionState?: string;
  status?: string;
  text?: string;
  prompt?: string;
  phase?: string;
  summary?: string[];
  content?: Array<string | TaskMessageContent>;
  suggestedPrompts?: Array<{ label?: string; prompt?: string } | null>;
  upload?: { lines?: TaskUploadLine[] } | null;
  name?: string;
  available?: boolean;
  paths?: string[];
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  approvalId?: string;
  title?: string;
  reason?: string;
  decisions?: string[];
  networkEndpoint?: string;
  grantRoot?: string;
  environment?: string;
  permissions?: Array<{
    label?: string;
    value?: string;
    verbatim?: boolean;
  } | null>;
  tool?: ApprovalTool | null;
  reviewed?: { concern?: number; model?: string } | null;
}

export interface TaskMessageContent {
  type?: string;
  text?: string;
  url?: string;
  path?: string;
  name?: string;
}

export interface TaskUploadLine {
  path: string;
  done?: boolean;
}

export interface ApprovalTool {
  serverName?: string;
  appName?: string;
  description?: string;
  arguments?: Array<{ name: string; label: string; value: unknown }>;
}

// A terminal belongs to one Task or one Section.
export interface TerminalSubject {
  kind: "task" | "section";
  id: string;
}

export interface NoteDirectorySummary {
  id: string;
  name: string;
  updatedAtMs: number;
  directoryCount: number;
  noteCount: number;
}

export interface NoteSummary {
  id: string;
  name: string;
  updatedAtMs: number;
}

// What one directory, or the top of the Notes tree, directly holds.
export interface NotesLevel {
  directories: NoteDirectorySummary[];
  notes: NoteSummary[];
}

// The Task that wrote a Note. A Task deleted since then keeps only its id.
export type NoteTask =
  | { threadId: string; state: "active" | "archived"; displayName: string }
  | { threadId: string; state: "deleted" };

export interface Note {
  id: string;
  name: string;
  content: string;
  // The directories that hold the Note, from the top of the tree.
  location: Array<{ id: string; name: string }>;
  createdAtMs: number;
  updatedAtMs: number;
  createdBy: NoteTask;
  updatedBy: NoteTask;
}

export interface CodexExecutable {
  path?: string | null;
  version?: string | null;
}

export interface CodexReadiness {
  state: string;
  blocksTaskOperations?: boolean;
  reasonCode?: string | null;
  diagnosticMessage?: string | null;
  minimumSupportedVersion?: string | null;
  detectedExecutable?: CodexExecutable | null;
  managedExecutable?: CodexExecutable | null;
  runningAppServerVersion?: string | null;
}

export interface CodexRateWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

// One limit Codex meters, with up to two windows.
export interface CodexRateLimit {
  limitId?: string;
  limitName?: string;
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
}

export interface CodexResetCredit {
  id?: string | null;
  resetType?: string | null;
  title?: string | null;
  grantedAt?: number | null;
  expiresAt?: number | null;
  status?: string;
}

// Codex's own report, passed through: the single-bucket view, every limit by
// its id, and the reset credits.
export interface CodexRateLimits {
  rateLimits?: CodexRateLimit | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimit> | null;
  rateLimitResetCredits?: {
    availableCount?: number;
    credits?: CodexResetCredit[] | null;
  } | null;
}

export interface CodexStatus {
  readiness?: CodexReadiness | null;
  account?: {
    accountType?: string;
    email?: string | null;
    planType?: string | null;
  } | null;
  rateLimits?: CodexRateLimits | null;
  daemon?: {
    status?: string;
    managedCodexVersion?: string | null;
    cliVersion?: string | null;
    appServerVersion?: string | null;
  } | null;
  diagnostics?: { processConnected?: boolean } | null;
}

export type CodexResetCreditOutcome =
  | "reset"
  | "alreadyRedeemed"
  | "nothingToReset"
  | "noCredit";

export interface CodexUpdateOutcome {
  status: "updated" | "noUpdate" | "unsupported";
  installedVersion?: string;
  runningVersion?: string;
  message: string;
}

// What the Task store said about whether it can take Task operations.
export interface TaskStoreReadiness {
  state: string;
  blocksTaskOperations: boolean;
  diagnosticMessage: string;
}

export interface CodexMcpDiagnostics {
  available: boolean;
  processGeneration: number | null;
  appServerVersion: string | null;
  threads: Array<{
    threadId: string;
    available: boolean;
    servers?: Array<{
      name?: string;
      runtimeStatus?: string;
      authStatus?: string;
    }>;
    error?: string | null;
  }>;
  error: string | null;
}

export interface CodexUpdates {
  update: "available" | "upToDate" | "unknown";
  installedVersion?: string | null;
  runningVersion?: string | null;
  latestVersion?: string | null;
  automaticUpdates?: string | null;
  problems?: { latestVersion?: string; installation?: string } | null;
}

// Each source answers for itself; one that could not answer names its problem
// under `problems` instead.
export interface ClaudeStatus {
  executable?: { path?: string; version: string };
  auth?: {
    loggedIn: boolean;
    method?: string;
    email?: string;
    subscription?: string;
  };
  usage?: {
    subscriptionType?: string;
    windows: Array<{
      kind: string;
      percent: number;
      resetsAt?: string;
      model?: string;
    }>;
  };
  runner?: {
    running: boolean;
    pid?: number;
    version?: string;
    sessions?: number;
    idleTimeoutSecs?: number;
  };
  problems?: Partial<
    Record<"executable" | "auth" | "usage" | "runner", string>
  >;
}

export interface GrokStatus {
  executable?: { path: string; version: string };
  leader?: {
    socketPath: string;
    running: boolean;
    socketStale: boolean;
    pid?: number;
    version?: string;
  };
  connection: {
    state: string;
    agentVersion?: string;
    authMethods: string[];
    defaultAuthMethod?: string;
  };
  auth: {
    cachedSignIn: boolean;
    verified?: {
      authenticated: boolean;
      mode?: string;
      subscriptionTier?: string;
      email?: string;
    };
  };
  usage?: {
    percent?: number;
    period?: { type?: string; start?: string; end?: string };
    onDemand?: { used?: number; cap?: number };
    prepaid?: { balance: number };
  };
  problems?: Partial<
    Record<"executable" | "auth" | "usage" | "leader" | "connection", string>
  >;
}

// What the server says about itself: the directories it serves, where New
// Task starts, and the build it runs.
export interface Health {
  root?: string | null;
  homePath?: string | null;
  initialPath?: string | null;
  buildId?: string | null;
  buildLabel?: string | null;
  version?: string | null;
}

export interface PushInstallation {
  clientId: string;
  installationLabel: string;
  updatedAtMs?: number;
}

export interface PushSubscriptionPayload {
  installationLabel: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

// What the Composer needs to offer voice input.
export interface VoiceStatus {
  provider: string;
  ready: boolean;
  maxRecordingSeconds: number;
}

// What a recording said, and which provider heard it.
export interface VoiceTranscript {
  text: string;
  provider: string;
}

// What the server reports about Caffold releases and the update Task.
export interface CaffoldUpdateStatus {
  version?: string | null;
  updateAvailable?: boolean;
  latestRelease?: { version: string; url: string } | null;
  releaseError?: string | null;
  runningAttempt?: { toVersion?: string | null } | null;
  lastAttempt?: CaffoldUpdateAttempt | null;
  updateTask?: { cwd: string; command: string } | null;
}

// How a Caffold update ended: rolled back, not restored, or done.
export interface CaffoldUpdateAttempt {
  id: string;
  outcome: string;
  fromVersion?: string;
  toVersion?: string | null;
  reason?: string;
  finishedAt?: string | null;
}
