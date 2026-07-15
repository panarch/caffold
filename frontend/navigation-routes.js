const PAGE_QUERY = [{ name: "page", key: "page", type: "positiveInteger", defaultValue: 1 }];
const COMPARE_QUERY = [
  { name: "base", key: "baseRef", defaultValue: "" },
  { name: "head", key: "headRef", defaultValue: "" },
];
const TASKS_QUERY = [{ name: "cwd", key: "cwd", defaultValue: "" }];
const CWD_QUERY = [{ name: "cwd", key: "cwd", defaultValue: "" }];
const FILE_QUERY = [...CWD_QUERY, { name: "file", key: "path", defaultValue: "" }];
const STANDALONE_COMPARE_QUERY = [
  ...CWD_QUERY,
  ...COMPARE_QUERY,
  { name: "file", key: "path", defaultValue: "" },
];
const STANDALONE_LOG_QUERY = [
  ...CWD_QUERY,
  ...PAGE_QUERY,
  { name: "sha", key: "sha", defaultValue: "" },
  { name: "file", key: "path", defaultValue: "" },
];
const STANDALONE_PAGE_QUERY = [...CWD_QUERY, ...PAGE_QUERY];
const STANDALONE_PULL_FILES_QUERY = [
  ...CWD_QUERY,
  ...PAGE_QUERY,
  { name: "file", key: "path", defaultValue: "" },
];

const ROUTE_DEFINITIONS = [
  routeDefinition({
    id: "settings",
    kind: "settings",
    pattern: "/settings",
    surface: "settings",
    target: "page",
    toRoute: () => ({ kind: "settings" }),
    parent: () => null,
  }),
  routeDefinition({
    id: "standalone-files",
    kind: "files",
    pattern: "/files",
    query: FILE_QUERY,
    target: (route) => (cleanPath(route.path) ? "path" : "list"),
    toRoute: (_, query) => standaloneFilesRoute(query),
    parent: (route) => (route.path ? standaloneFilesRoute({ cwd: route.cwd }) : null),
  }),
  routeDefinition({
    id: "standalone-diff",
    kind: "diff",
    pattern: "/git/diff",
    query: FILE_QUERY,
    domain: "git",
    target: (route) => (cleanPath(route.path) ? "file" : "list"),
    toRoute: (_, query) => standaloneDiffRoute(query),
    parent: (route) =>
      route.path
        ? standaloneDiffRoute({ cwd: route.cwd })
        : standaloneFilesRoute({ cwd: route.cwd }),
  }),
  routeDefinition({
    id: "standalone-compare",
    kind: "compare",
    pattern: "/git/compare",
    query: STANDALONE_COMPARE_QUERY,
    domain: "git",
    target: (route) => (cleanPath(route.path) ? "file" : "list"),
    toRoute: (_, query) => standaloneCompareRoute(query),
    parent: (route) =>
      route.path
        ? standaloneCompareRoute({
            cwd: route.cwd,
            baseRef: route.baseRef,
            headRef: route.headRef,
          })
        : standaloneFilesRoute({ cwd: route.cwd }),
  }),
  routeDefinition({
    id: "standalone-log",
    kind: "log",
    pattern: "/git/log",
    query: STANDALONE_LOG_QUERY,
    domain: "git",
    target: (route) => (route.path ? "file" : route.sha ? "commit" : "list"),
    toRoute: (_, query) => standaloneLogRoute(query),
    parent: (route) => {
      if (route.path) {
        return standaloneLogRoute({
          cwd: route.cwd,
          page: route.page,
          sha: route.sha,
        });
      }
      if (route.sha) {
        return standaloneLogRoute({ cwd: route.cwd, page: route.page });
      }
      return standaloneFilesRoute({ cwd: route.cwd });
    },
  }),
  routeDefinition({
    id: "standalone-issues-list",
    kind: "issues",
    pattern: "/github/issues",
    query: STANDALONE_PAGE_QUERY,
    domain: "github",
    target: "list",
    toRoute: (_, query) => standaloneIssuesRoute(query),
    parent: (route) => standaloneFilesRoute({ cwd: route.cwd }),
  }),
  routeDefinition({
    id: "standalone-issues-detail",
    kind: "issues",
    pattern: "/github/issues/[number]",
    query: STANDALONE_PAGE_QUERY,
    domain: "github",
    target: "detail",
    params: { number: "positiveInteger" },
    toRoute: ({ number }, query) => standaloneIssuesRoute({ ...query, number }),
    parent: (route) => standaloneIssuesRoute({ cwd: route.cwd, page: route.page }),
  }),
  routeDefinition({
    id: "standalone-pulls-list",
    kind: "pulls",
    pattern: "/github/pulls",
    query: STANDALONE_PAGE_QUERY,
    domain: "github",
    target: "list",
    toRoute: (_, query) => standalonePullsRoute(query),
    parent: (route) => standaloneFilesRoute({ cwd: route.cwd }),
  }),
  routeDefinition({
    id: "standalone-pulls-detail",
    kind: "pulls",
    pattern: "/github/pulls/[number]",
    query: STANDALONE_PAGE_QUERY,
    domain: "github",
    target: "detail",
    params: { number: "positiveInteger" },
    toRoute: ({ number }, query) => standalonePullsRoute({ ...query, number }),
    parent: (route) => standalonePullsRoute({ cwd: route.cwd, page: route.page }),
  }),
  routeDefinition({
    id: "standalone-pulls-files",
    kind: "pulls",
    pattern: "/github/pulls/[number]/files",
    query: STANDALONE_PULL_FILES_QUERY,
    domain: "github",
    target: (route) => (cleanPath(route.path) ? "file" : "files"),
    params: { number: "positiveInteger" },
    toRoute: ({ number }, query) =>
      standalonePullsRoute({ ...query, number, files: true }),
    parent: (route) =>
      route.path
        ? standalonePullsRoute({
            cwd: route.cwd,
            page: route.page,
            number: route.number,
            files: true,
          })
        : standalonePullsRoute({
            cwd: route.cwd,
            page: route.page,
            number: route.number,
          }),
  }),
  routeDefinition({
    id: "global-tasks-list",
    kind: "tasks",
    pattern: "/tasks",
    query: TASKS_QUERY,
    surface: "tasks",
    target: "list",
    toRoute: (_, query) => tasksRoute(query),
    matchesRoute: (route) => route?.kind === "tasks" && !route.new && !route.threadId,
    parent: () => null,
  }),
  routeDefinition({
    id: "global-tasks-new",
    kind: "tasks",
    pattern: "/tasks/new",
    query: TASKS_QUERY,
    surface: "tasks",
    target: "new",
    toRoute: (_, query) => tasksRoute({ ...query, new: true }),
    matchesRoute: (route) => route?.kind === "tasks" && Boolean(route.new),
    parent: (route) => tasksRoute({ cwd: route.cwd }),
  }),
  routeDefinition({
    id: "global-tasks-detail",
    kind: "tasks",
    pattern: "/tasks/[threadId]",
    query: TASKS_QUERY,
    surface: "tasks",
    target: "detail",
    toRoute: ({ threadId }, query) => tasksRoute({ ...query, threadId }),
    matchesRoute: (route) => route?.kind === "tasks" && Boolean(route.threadId),
    parent: (route) => tasksRoute({ cwd: route.cwd }),
  }),
];

const CANONICAL_ROUTE_DEFINITIONS = ROUTE_DEFINITIONS.filter(
  (definition) => definition.canonical !== false,
);

export function parseRoute(url = window.location.href) {
  const parsed = new URL(url, routeOrigin());
  for (const definition of ROUTE_DEFINITIONS) {
    const fields = matchPath(definition, parsed.pathname);
    if (!fields) {
      continue;
    }

    return definition.toRoute(fields, parseQuery(definition, parsed));
  }

  return null;
}

export function routeUrl(route) {
  const definition = routeDefinitionFor(route);
  const url = new URL(routeOrigin());
  if (!definition) {
    url.pathname = "/";
    return `${url.pathname}${url.search}`;
  }

  url.pathname = buildPath(definition, route);
  writeQuery(definition, route, url.searchParams);
  return `${url.pathname}${url.search}`;
}

export function parentRoute(route) {
  if (!route) {
    return null;
  }

  return routeDefinitionFor(route)?.parent?.(route) ?? null;
}

export function routeEquals(left, right) {
  return routeUrl(left) === routeUrl(right);
}

export function routeSurface(route) {
  return routeDefinitionFor(route)?.surface ?? "files";
}

export function routeDomain(route) {
  return routeDefinitionFor(route)?.domain ?? null;
}

export function routeMode(route) {
  return routeDefinitionFor(route)?.kind ?? null;
}

export function routeTarget(route) {
  const target = routeDefinitionFor(route)?.target;
  return typeof target === "function" ? target(route) : (target ?? null);
}

function routeDefinition(config) {
  const definition = {
    ...config,
    surface: config.surface ?? (config.domain ? "review" : "files"),
    tokens: compilePattern(config.pattern),
    query: config.query ?? [],
    params: config.params ?? {},
  };
  definition.matchesRoute ??= (route) => routeMatchesDefinition(definition, route);
  return definition;
}

function routeDefinitionFor(route) {
  return CANONICAL_ROUTE_DEFINITIONS.find((definition) => definition.matchesRoute(route)) ?? null;
}

function routeMatchesDefinition(definition, route) {
  if (route?.kind !== definition.kind) {
    return false;
  }

  for (const token of definition.tokens) {
    if (token.kind !== "param") {
      continue;
    }
    if (!route[token.name]) {
      return false;
    }
  }

  for (const key of ["threadId", "sha", "number"]) {
    const queryOwnsKey = definition.query.some((query) => query.key === key);
    if (!hasToken(definition, "param", key) && !queryOwnsKey && route?.[key]) {
      return false;
    }
  }

  const pathIsQuery = definition.query.some((query) => query.key === "path");
  if (
    !pathIsQuery &&
    hasToken(definition, "rest", "path") !== Boolean(cleanPath(route.path))
  ) {
    return false;
  }

  if (definition.kind === "pulls") {
    const target =
      typeof definition.target === "function" ? definition.target(route) : definition.target;
    const expectsFilesTarget = target === "files" || target === "file";
    if (Boolean(route.files) !== expectsFilesTarget) {
      return false;
    }
  }

  return true;
}

function hasToken(definition, kind, name) {
  return definition.tokens.some((token) => token.kind === kind && token.name === name);
}

function compilePattern(pattern) {
  return pattern
    .split("/")
    .filter(Boolean)
    .map((part) => {
      const restMatch = part.match(/^\[\.\.\.(.+)]$/);
      if (restMatch) {
        return { kind: "rest", name: restMatch[1] };
      }

      const paramMatch = part.match(/^\[(.+)]$/);
      if (paramMatch) {
        return { kind: "param", name: paramMatch[1] };
      }

      return { kind: "literal", value: part };
    });
}

function matchPath(definition, pathname) {
  const segments = rawPathSegments(pathname);
  const fields = {};
  let segmentIndex = 0;

  for (const token of definition.tokens) {
    if (token.kind === "rest") {
      if (segmentIndex >= segments.length) {
        return null;
      }

      fields[token.name] = decodePathTail(segments.slice(segmentIndex));
      return fields[token.name] ? fields : null;
    }

    const segment = segments[segmentIndex];
    if (segment === undefined) {
      return null;
    }

    if (token.kind === "literal") {
      if (safeDecode(segment) !== token.value) {
        return null;
      }
      segmentIndex += 1;
      continue;
    }

    const value = decodeParam(definition, token.name, segment);
    if (value === null) {
      return null;
    }

    fields[token.name] = value;
    segmentIndex += 1;
  }

  return segmentIndex === segments.length ? fields : null;
}

function buildPath(definition, route) {
  const parts = [];
  for (const token of definition.tokens) {
    if (token.kind === "literal") {
      parts.push(token.value);
      continue;
    }

    if (token.kind === "rest") {
      const clean = cleanPath(route[token.name]);
      parts.push(...clean.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)));
      continue;
    }

    parts.push(encodeURIComponent(route[token.name]));
  }

  return `/${parts.join("/")}`;
}

function decodeParam(definition, name, segment) {
  const value = safeDecode(segment);
  if (definition.params[name] === "positiveInteger") {
    return positiveInteger(value);
  }

  return value;
}

function parseQuery(definition, url) {
  const values = {};
  for (const query of definition.query) {
    const rawValue = url.searchParams.get(query.name);
    if (query.type === "positiveInteger") {
      values[query.key] = positiveInteger(rawValue) ?? query.defaultValue;
    } else {
      values[query.key] = rawValue ?? query.defaultValue;
    }
  }
  return values;
}

function writeQuery(definition, route, searchParams) {
  for (const query of definition.query) {
    const value = route[query.key] ?? query.defaultValue;
    if (`${value}` === `${query.defaultValue}` || value === "") {
      continue;
    }

    searchParams.set(query.name, `${value}`);
  }
}

function tasksRoute(options = {}) {
  return {
    kind: "tasks",
    new: Boolean(options.new),
    threadId: options.threadId ?? "",
    cwd: taskCwd(options.cwd),
  };
}

function standaloneFilesRoute(options = {}) {
  return {
    kind: "files",
    cwd: taskCwd(options.cwd),
    path: cleanPath(options.path),
  };
}

function standaloneDiffRoute(options = {}) {
  return {
    kind: "diff",
    cwd: taskCwd(options.cwd),
    path: cleanPath(options.path),
  };
}

function standaloneCompareRoute(options = {}) {
  return {
    kind: "compare",
    cwd: taskCwd(options.cwd),
    baseRef: options.baseRef ?? "",
    headRef: options.headRef ?? "",
    path: cleanPath(options.path),
  };
}

function standaloneLogRoute(options = {}) {
  return {
    kind: "log",
    cwd: taskCwd(options.cwd),
    page: options.page ?? 1,
    sha: options.sha ?? "",
    path: cleanPath(options.path),
  };
}

function standaloneIssuesRoute(options = {}) {
  return {
    kind: "issues",
    cwd: taskCwd(options.cwd),
    page: options.page ?? 1,
    number: options.number ?? null,
  };
}

function standalonePullsRoute(options = {}) {
  return {
    kind: "pulls",
    cwd: taskCwd(options.cwd),
    page: options.page ?? 1,
    number: options.number ?? null,
    files: Boolean(options.files),
    path: cleanPath(options.path),
  };
}

function taskCwd(path) {
  return path === "." ? "." : cleanPath(path);
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

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
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
