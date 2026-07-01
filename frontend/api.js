export async function getHealth() {
  return requestJson("/api/health");
}

export async function listDirectory(path = "") {
  return requestJson("/api/list", { path });
}

export async function readFile(path) {
  return requestJson("/api/file", { path });
}

export function imageUrl(path) {
  const url = new URL("/api/image", window.location.origin);
  url.searchParams.set("path", path);
  return url.toString();
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

export async function listProjects() {
  return requestJson("/api/projects");
}

export async function getProjectCandidate(path = "") {
  return requestJson("/api/project-candidate", { path });
}

export async function createProject(project) {
  return requestJson("/api/projects", {}, {
    method: "POST",
    body: project,
  });
}

export async function renameProject(id, name) {
  return requestJson(`/api/projects/${encodeURIComponent(id)}`, {}, {
    method: "PATCH",
    body: { name },
  });
}

export async function deleteProject(id) {
  return requestJson(`/api/projects/${encodeURIComponent(id)}`, {}, {
    method: "DELETE",
    expectJson: false,
  });
}

export async function openProject(id) {
  return requestJson(`/api/projects/${encodeURIComponent(id)}/open`, {}, {
    method: "POST",
  });
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

  if (options.body !== undefined) {
    fetchOptions.headers = {
      "content-type": "application/json",
    };
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ?? `Request failed with HTTP ${response.status}`,
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
