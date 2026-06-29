export async function getHealth() {
  return requestJson("/api/health");
}

export async function listDirectory(path = "") {
  return requestJson("/api/list", { path });
}

export async function readFile(path) {
  return requestJson("/api/file", { path });
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

