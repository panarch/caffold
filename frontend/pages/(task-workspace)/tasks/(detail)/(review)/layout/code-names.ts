import type { LanguageServerRepository } from "#app/api.js";
import type { CodeNamesState } from "#components/file-viewer.js";
import { cleanLogicalPath } from "#tasks/task-format.js";

// Whether the names in the file at logical `path` can be pressed, from its
// repository's language servers: only inside a repository that has them on,
// for a file one of them reads.
export function codeNamesFor(
  repository: LanguageServerRepository | null,
  path: string,
): CodeNamesState | null {
  if (!repository?.enabled || !insideFolder(path, repository.path)) {
    return null;
  }
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const server = path.includes(".")
    ? repository.servers.find((candidate) =>
        candidate.extensions.includes(extension),
      )
    : undefined;
  switch (server?.state) {
    case "ready":
      return { status: "ready" };
    case "starting":
      return server.progress
        ? { status: "starting", progress: server.progress }
        : { status: "starting" };
    case "sleeping":
      return { status: "starting" };
    default:
      return null;
  }
}

// Whether the repository's servers are on their way to ready, which the
// screens showing it follow by reading again.
export function languageServersGettingReady(
  repository: LanguageServerRepository | null,
) {
  return Boolean(
    repository?.enabled &&
      repository.servers.some(
        (server) => server.state === "starting" || server.state === "sleeping",
      ),
  );
}

function insideFolder(path: string, folder: string) {
  const file = cleanLogicalPath(path);
  const root = cleanLogicalPath(folder);
  if (!file) {
    return false;
  }
  return !root || file.startsWith(`${root}/`);
}
