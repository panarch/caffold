const PROJECTS_PREFIX = "projects";

export function parseRoute(url = window.location.href) {
  const parsed = new URL(url, window.location.origin);
  const segments = rawPathSegments(parsed.pathname);
  if (safeDecode(segments[0]) !== PROJECTS_PREFIX || !segments[1]) {
    return null;
  }

  const projectId = safeDecode(segments[1]);
  const area = safeDecode(segments[2] ?? "files");
  const tail = segments.slice(3);

  if (area === "files") {
    return {
      kind: "files",
      projectId,
      path: decodePathTail(tail),
    };
  }

  if (area === "diff") {
    return {
      kind: "diff",
      projectId,
      path: decodePathTail(tail),
    };
  }

  if (area === "compare") {
    return {
      kind: "compare",
      projectId,
      baseRef: parsed.searchParams.get("base") ?? "",
      headRef: parsed.searchParams.get("head") ?? "",
      path: decodePathTail(tail),
    };
  }

  if (area === "log") {
    const sha = tail[0] ?? "";
    return {
      kind: "log",
      projectId,
      page: positiveInteger(parsed.searchParams.get("page")) ?? 1,
      sha,
      path: decodePathTail(tail.slice(1)),
    };
  }

  if (area === "issues") {
    return {
      kind: "issues",
      projectId,
      page: positiveInteger(parsed.searchParams.get("page")) ?? 1,
      number: positiveInteger(tail[0]),
    };
  }

  if (area === "pulls") {
    const number = positiveInteger(tail[0]);
    const isFilesRoute = tail[1] === "files";
    return {
      kind: "pulls",
      projectId,
      page: positiveInteger(parsed.searchParams.get("page")) ?? 1,
      number,
      files: Boolean(number && isFilesRoute),
      path: number && isFilesRoute ? decodePathTail(tail.slice(2)) : "",
    };
  }

  return null;
}

export function routeUrl(route) {
  const url = new URL(window.location.origin);
  url.pathname = routePath(route);

  if (route.kind === "compare") {
    if (route.baseRef) {
      url.searchParams.set("base", route.baseRef);
    }
    if (route.headRef) {
      url.searchParams.set("head", route.headRef);
    }
  }

  if ((route.kind === "log" || route.kind === "issues" || route.kind === "pulls") && route.page > 1) {
    url.searchParams.set("page", `${route.page}`);
  }

  return `${url.pathname}${url.search}`;
}

export function parentRoute(route) {
  if (!route) {
    return null;
  }

  if (route.kind === "files" && route.path) {
    return { kind: "files", projectId: route.projectId, path: parentPath(route.path) };
  }

  if (route.kind === "diff" && route.path) {
    return { kind: "diff", projectId: route.projectId, path: "" };
  }

  if (route.kind === "compare" && route.path) {
    return {
      kind: "compare",
      projectId: route.projectId,
      baseRef: route.baseRef,
      headRef: route.headRef,
      path: "",
    };
  }

  if (route.kind === "log" && route.sha && route.path) {
    return {
      kind: "log",
      projectId: route.projectId,
      page: route.page,
      sha: route.sha,
      path: "",
    };
  }

  if (route.kind === "log" && route.sha) {
    return { kind: "log", projectId: route.projectId, page: route.page };
  }

  if (route.kind === "issues" && route.number) {
    return { kind: "issues", projectId: route.projectId, page: route.page };
  }

  if (route.kind === "pulls" && route.number && route.files && route.path) {
    return {
      kind: "pulls",
      projectId: route.projectId,
      page: route.page,
      number: route.number,
      files: true,
      path: "",
    };
  }

  if (route.kind === "pulls" && route.number && route.files) {
    return {
      kind: "pulls",
      projectId: route.projectId,
      page: route.page,
      number: route.number,
    };
  }

  if (route.kind === "pulls" && route.number) {
    return { kind: "pulls", projectId: route.projectId, page: route.page };
  }

  if (route.kind !== "files") {
    return { kind: "files", projectId: route.projectId, path: "" };
  }

  return null;
}

export function routeEquals(left, right) {
  return routeUrl(left) === routeUrl(right);
}

function routePath(route) {
  const base = `/${PROJECTS_PREFIX}/${encodeURIComponent(route.projectId)}`;
  if (route.kind === "files") {
    return `${base}/files${encodedTail(route.path)}`;
  }
  if (route.kind === "diff") {
    return `${base}/diff${encodedTail(route.path)}`;
  }
  if (route.kind === "compare") {
    return `${base}/compare${encodedTail(route.path)}`;
  }
  if (route.kind === "log") {
    const commitTail = route.sha ? `/${encodeURIComponent(route.sha)}${encodedTail(route.path)}` : "";
    return `${base}/log${commitTail}`;
  }
  if (route.kind === "issues") {
    const issueTail = route.number ? `/${encodeURIComponent(route.number)}` : "";
    return `${base}/issues${issueTail}`;
  }
  if (route.kind === "pulls") {
    if (!route.number) {
      return `${base}/pulls`;
    }

    const filesTail = route.files ? `/files${encodedTail(route.path)}` : "";
    return `${base}/pulls/${encodeURIComponent(route.number)}${filesTail}`;
  }

  return "/";
}

function rawPathSegments(pathname) {
  return pathname
    .split("/")
    .filter(Boolean);
}

function decodePathTail(segments) {
  return cleanPath(segments.map((segment) => safeDecode(segment)).join("/"));
}

function encodedTail(path) {
  const clean = cleanPath(path);
  if (!clean) {
    return "";
  }

  return `/${clean.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function parentPath(path) {
  const parts = cleanPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function positiveInteger(value) {
  const number = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
