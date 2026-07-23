export async function getHealth() {
  return requestJson("/api/health");
}

export async function getCodexStatus() {
  return requestJson("/api/codex/status");
}

export async function getCodexModels() {
  return requestJson("/api/codex/models");
}

export async function getCodexPermissions(cwd = "") {
  return requestJson("/api/codex/permissions", cwd ? { cwd } : {});
}

export async function getTasks(cursor = null) {
  return requestJson("/api/tasks", {
    ...(cursor ? { cursor } : {}),
  });
}

export async function getTaskHistory(cursor = null) {
  return requestJson("/api/task-history", {
    ...(cursor ? { cursor } : {}),
  });
}

export async function continueTask(threadId) {
  return requestJson(`/api/tasks/${encodeURIComponent(threadId)}/continue`, {}, {
    method: "POST",
  });
}

export async function markTaskSeen(threadId) {
  return requestJson(`/api/tasks/${encodeURIComponent(threadId)}/seen`, {}, {
    method: "PUT",
  });
}

export async function createTask(task) {
  return requestJson("/api/tasks", {}, {
    method: "POST",
    body: task,
  });
}

export async function getTask(threadId, cursor = null) {
  return requestJson(`/api/tasks/${encodeURIComponent(threadId)}`, { cursor });
}

export async function sendTaskPrompt(threadId, prompt, options = {}, images = []) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/prompts`,
    {},
    {
      method: "POST",
      body: { prompt, images, ...options },
    },
  );
}

export async function interruptTask(threadId) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/interrupt`,
    {},
    {
      method: "POST",
    },
  );
}

export async function resolveTaskApproval(threadId, approvalId, decision) {
  return requestJson(
    `/api/tasks/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(approvalId)}`,
    {},
    {
      method: "POST",
      body: { decision },
    },
  );
}

export function taskStreamUrl(threadId) {
  const url = new URL(`/api/tasks/${encodeURIComponent(threadId)}/stream`, window.location.origin);
  return `${url.pathname}${url.search}`;
}

export function taskListStreamUrl() {
  const url = new URL("/api/tasks/stream", window.location.origin);
  return `${url.pathname}${url.search}`;
}

export async function listDirectory(path = "") {
  return requestJson("/api/list", { path }, { timeoutMs: 7000 });
}

export async function readFile(path) {
  return requestJson("/api/file", { path });
}

export function imageUrl(path) {
  const url = new URL("/api/image", window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
}

export function watchUrl(path = "") {
  const url = new URL("/api/watch", window.location.origin);
  url.searchParams.set("path", path);
  return `${url.pathname}${url.search}`;
}

export async function getGitStatus(path = "") {
  return requestJson("/api/git/status", { path });
}

export async function getGitDiff(path = "", file, kind = "unstaged") {
  return requestJson("/api/git/diff", { path, file, kind });
}

export async function getGitLog(path = "", page = 1, perPage = 50) {
  return requestJson("/api/git/log", { path, page, perPage });
}

export async function getGitCommit(path = "", sha) {
  return requestJson("/api/git/commit", { path, sha });
}

export async function getGitCommitDiff(path = "", sha, file) {
  return requestJson("/api/git/commit-diff", { path, sha, file });
}

export async function getGitCompare(path = "", base = null, head = null) {
  return requestJson("/api/git/compare", { path, base, head });
}

export async function getGitRefs(path = "") {
  return requestJson("/api/git/refs", { path });
}

export async function getGitCompareDiff(path = "", base = null, head = null, file) {
  return requestJson("/api/git/compare-diff", { path, base, head, file });
}

export async function getGitHubStatus(path = "") {
  return requestJson("/api/github/status", { path });
}

export async function getGitHubIssues(path = "", state = "open", page = 1, perPage = 50) {
  return requestJson("/api/github/issues", { path, state, page, perPage });
}

export async function getGitHubIssue(path = "", number) {
  return requestJson("/api/github/issue", { path, number });
}

export async function getGitHubPulls(path = "", state = "open", page = 1, perPage = 50) {
  return requestJson("/api/github/pulls", { path, state, page, perPage });
}

export async function getGitHubPull(path = "", number) {
  return requestJson("/api/github/pull", { path, number });
}

export async function getGitHubPullFiles(path = "", number) {
  return requestJson("/api/github/pull-files", { path, number });
}

export async function getGitHubPullFile(path = "", number, file) {
  return requestJson("/api/github/pull-file", { path, number, file });
}

async function requestJson(endpoint, params = {}, options = {}) {
  const url = new URL(endpoint, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const fetchOptions = {
    method: options.method ?? "GET",
  };
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  if (controller) {
    fetchOptions.signal = controller.signal;
  }

  if (options.body !== undefined) {
    fetchOptions.headers = {
      "content-type": "application/json",
    };
    fetchOptions.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    if (controller?.signal.aborted) {
      const timeoutError = new Error("Request timed out.");
      timeoutError.code = "request_timeout";
      timeoutError.status = 0;
      throw timeoutError;
    }

    throw error;
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ??
        (typeof payload?.error === "string" ? payload.error : null) ??
        `Request failed with HTTP ${response.status}`,
    );
    error.code = payload?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }

  if (options.expectJson === false) {
    return null;
  }

  return payload;
}
