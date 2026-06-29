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

async function requestJson(endpoint, params = {}) {
  const url = new URL(endpoint, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ?? `Request failed with HTTP ${response.status}`,
    );
    error.code = payload?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }

  return payload;
}
