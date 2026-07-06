const PROJECTS_PREFIX = "projects";

const ROUTE_DEFINITIONS = [
  {
    kind: "files",
    area: "files",
    surface: "files",
    mode: "files",
    parse({ projectId, tail }) {
      return {
        kind: "files",
        projectId,
        path: decodePathTail(tail),
      };
    },
    path(route, base) {
      return `${base}/files${encodedTail(route.path)}`;
    },
    parent(route) {
      return route.path
        ? { kind: "files", projectId: route.projectId, path: parentPath(route.path) }
        : null;
    },
  },
  {
    kind: "diff",
    area: "diff",
    surface: "review",
    domain: "git",
    mode: "diff",
    parse({ projectId, tail }) {
      return {
        kind: "diff",
        projectId,
        path: decodePathTail(tail),
      };
    },
    path(route, base) {
      return `${base}/diff${encodedTail(route.path)}`;
    },
    parent(route) {
      return route.path ? { kind: "diff", projectId: route.projectId, path: "" } : null;
    },
  },
  {
    kind: "compare",
    area: "compare",
    surface: "review",
    domain: "git",
    mode: "compare",
    parse({ projectId, tail, url }) {
      return {
        kind: "compare",
        projectId,
        baseRef: url.searchParams.get("base") ?? "",
        headRef: url.searchParams.get("head") ?? "",
        path: decodePathTail(tail),
      };
    },
    path(route, base) {
      return `${base}/compare${encodedTail(route.path)}`;
    },
    query(route, searchParams) {
      if (route.baseRef) {
        searchParams.set("base", route.baseRef);
      }
      if (route.headRef) {
        searchParams.set("head", route.headRef);
      }
    },
    parent(route) {
      return route.path
        ? {
            kind: "compare",
            projectId: route.projectId,
            baseRef: route.baseRef,
            headRef: route.headRef,
            path: "",
          }
        : null;
    },
  },
  {
    kind: "log",
    area: "log",
    surface: "review",
    domain: "git",
    mode: "log",
    parse({ projectId, tail, url }) {
      const sha = tail[0] ?? "";
      return {
        kind: "log",
        projectId,
        page: pageParam(url),
        sha,
        path: decodePathTail(tail.slice(1)),
      };
    },
    path(route, base) {
      const commitTail = route.sha
        ? `/${encodeURIComponent(route.sha)}${encodedTail(route.path)}`
        : "";
      return `${base}/log${commitTail}`;
    },
    query(route, searchParams) {
      setPageParam(route, searchParams);
    },
    parent(route) {
      if (route.sha && route.path) {
        return {
          kind: "log",
          projectId: route.projectId,
          page: route.page,
          sha: route.sha,
          path: "",
        };
      }

      return route.sha
        ? { kind: "log", projectId: route.projectId, page: route.page }
        : null;
    },
  },
  {
    kind: "issues",
    area: "issues",
    surface: "review",
    domain: "github",
    mode: "issues",
    parse({ projectId, tail, url }) {
      return {
        kind: "issues",
        projectId,
        page: pageParam(url),
        number: positiveInteger(tail[0]),
      };
    },
    path(route, base) {
      const issueTail = route.number ? `/${encodeURIComponent(route.number)}` : "";
      return `${base}/issues${issueTail}`;
    },
    query(route, searchParams) {
      setPageParam(route, searchParams);
    },
    parent(route) {
      return route.number
        ? { kind: "issues", projectId: route.projectId, page: route.page }
        : null;
    },
  },
  {
    kind: "pulls",
    area: "pulls",
    surface: "review",
    domain: "github",
    mode: "pulls",
    parse({ projectId, tail, url }) {
      const number = positiveInteger(tail[0]);
      const isFilesRoute = tail[1] === "files";
      return {
        kind: "pulls",
        projectId,
        page: pageParam(url),
        number,
        files: Boolean(number && isFilesRoute),
        path: number && isFilesRoute ? decodePathTail(tail.slice(2)) : "",
      };
    },
    path(route, base) {
      if (!route.number) {
        return `${base}/pulls`;
      }

      const filesTail = route.files ? `/files${encodedTail(route.path)}` : "";
      return `${base}/pulls/${encodeURIComponent(route.number)}${filesTail}`;
    },
    query(route, searchParams) {
      setPageParam(route, searchParams);
    },
    parent(route) {
      if (route.number && route.files && route.path) {
        return {
          kind: "pulls",
          projectId: route.projectId,
          page: route.page,
          number: route.number,
          files: true,
          path: "",
        };
      }

      if (route.number && route.files) {
        return {
          kind: "pulls",
          projectId: route.projectId,
          page: route.page,
          number: route.number,
        };
      }

      return route.number
        ? { kind: "pulls", projectId: route.projectId, page: route.page }
        : null;
    },
  },
];

const ROUTE_BY_AREA = new Map(
  ROUTE_DEFINITIONS.map((definition) => [definition.area, definition]),
);
const ROUTE_BY_KIND = new Map(
  ROUTE_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

export function parseRoute(url = window.location.href) {
  const parsed = new URL(url, routeOrigin());
  const segments = rawPathSegments(parsed.pathname);
  if (safeDecode(segments[0]) !== PROJECTS_PREFIX || !segments[1]) {
    return null;
  }

  const projectId = safeDecode(segments[1]);
  const area = safeDecode(segments[2] ?? "files");
  const definition = ROUTE_BY_AREA.get(area);
  if (!definition) {
    return null;
  }

  return definition.parse({
    projectId,
    tail: segments.slice(3),
    url: parsed,
  });
}

export function routeUrl(route) {
  const definition = ROUTE_BY_KIND.get(route?.kind);
  const url = new URL(routeOrigin());
  if (!definition) {
    url.pathname = "/";
    return `${url.pathname}${url.search}`;
  }

  url.pathname = definition.path(route, projectBase(route.projectId));
  definition.query?.(route, url.searchParams);
  return `${url.pathname}${url.search}`;
}

export function parentRoute(route) {
  if (!route) {
    return null;
  }

  const parent = ROUTE_BY_KIND.get(route.kind)?.parent(route);
  if (parent) {
    return parent;
  }

  if (route.kind !== "files") {
    return { kind: "files", projectId: route.projectId, path: "" };
  }

  return null;
}

export function routeEquals(left, right) {
  return routeUrl(left) === routeUrl(right);
}

export function routeSurface(route) {
  return ROUTE_BY_KIND.get(route?.kind)?.surface ?? "files";
}

export function routeDomain(route) {
  return ROUTE_BY_KIND.get(route?.kind)?.domain ?? null;
}

export function routeMode(route) {
  return ROUTE_BY_KIND.get(route?.kind)?.mode ?? null;
}

function projectBase(projectId) {
  return `/${PROJECTS_PREFIX}/${encodeURIComponent(projectId)}`;
}

function pageParam(url) {
  return positiveInteger(url.searchParams.get("page")) ?? 1;
}

function setPageParam(route, searchParams) {
  if (route.page > 1) {
    searchParams.set("page", `${route.page}`);
  }
}

function routeOrigin() {
  return window.location.origin;
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
