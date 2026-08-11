const PAGE_QUERY = [{ name: "page", key: "page", type: "positiveInteger", defaultValue: 1 }];
const COMPARE_QUERY = [
  { name: "base", key: "baseRef", defaultValue: "" },
  { name: "head", key: "headRef", defaultValue: "" },
];
const CWD_QUERY = [{ name: "cwd", key: "cwd", defaultValue: "" }];
const NEW_TASK_QUERY = [...CWD_QUERY];
const TASK_REVIEW_QUERY = [
  { name: "scope", key: "reviewScope", defaultValue: "working" },
  { name: "nav", key: "reviewNavigator", defaultValue: "changes" },
  { name: "view", key: "reviewViewer", defaultValue: "diff" },
  { name: "file", key: "path", defaultValue: "" },
  { name: "base", key: "baseRef", defaultValue: "" },
];
const FILE_QUERY = [{ name: "file", key: "path", defaultValue: "" }];
const GIT_COMPARE_QUERY = [
  ...COMPARE_QUERY,
  { name: "file", key: "path", defaultValue: "" },
];
const GIT_LOG_QUERY = [
  ...PAGE_QUERY,
  { name: "sha", key: "sha", defaultValue: "" },
  { name: "file", key: "path", defaultValue: "" },
];
const PULL_FILES_QUERY = [...PAGE_QUERY, ...FILE_QUERY];

const ROUTE_DEFINITIONS = [
  routeDefinition({
    id: "settings-home",
    kind: "settings",
    pattern: "/settings",
    surface: "task-workspace",
    target: "list",
    toRoute: () => settingsRoute(),
    matchesRoute: (route) => route?.kind === "settings" && !route.section,
    parent: () => null,
  }),
  routeDefinition({
    id: "settings-appearance",
    kind: "settings",
    pattern: "/settings/appearance",
    surface: "task-workspace",
    target: "appearance",
    toRoute: () => settingsRoute("appearance"),
    matchesRoute: (route) =>
      route?.kind === "settings" && route.section === "appearance",
    parent: () => settingsRoute(),
  }),
  routeDefinition({
    id: "settings-codex",
    kind: "settings",
    pattern: "/settings/codex",
    surface: "task-workspace",
    target: "codex",
    toRoute: () => settingsRoute("codex"),
    matchesRoute: (route) =>
      route?.kind === "settings" && route.section === "codex",
    parent: () => settingsRoute(),
  }),
  routeDefinition({
    id: "settings-about",
    kind: "settings",
    pattern: "/settings/about",
    surface: "task-workspace",
    target: "about",
    toRoute: () => settingsRoute("about"),
    matchesRoute: (route) =>
      route?.kind === "settings" && route.section === "about",
    parent: () => settingsRoute(),
  }),
  routeDefinition({
    id: "global-tasks-home",
    kind: "tasks",
    pattern: "/",
    surface: "task-workspace",
    target: "home",
    toRoute: (_, query) => tasksRoute(query),
    matchesRoute: (route) => route?.kind === "tasks" && !route.new && !route.threadId,
    parent: () => null,
  }),
  routeDefinition({
    id: "legacy-global-tasks-list",
    kind: "tasks",
    pattern: "/tasks",
    canonical: false,
    surface: "task-workspace",
    target: "home",
    toRoute: (_, query) => tasksRoute(query),
  }),
  routeDefinition({
    id: "global-tasks-new",
    kind: "tasks",
    pattern: "/tasks/new",
    query: NEW_TASK_QUERY,
    surface: "task-workspace",
    target: "new",
    toRoute: (_, query) => tasksRoute({ ...query, new: true }),
    matchesRoute: (route) => route?.kind === "tasks" && Boolean(route.new),
    parent: () => tasksRoute(),
  }),
  routeDefinition({
    id: "global-tasks-review",
    kind: "tasks",
    pattern: "/tasks/[threadId]/review",
    query: TASK_REVIEW_QUERY,
    surface: "task-workspace",
    target: (route) => (cleanPath(route.path) ? "review-file" : "review"),
    params: { threadId: "string" },
    toRoute: ({ threadId }, query) =>
      tasksRoute({ ...query, threadId, review: true }),
    matchesRoute: (route) =>
      route?.kind === "tasks" && Boolean(route.threadId) && Boolean(route.review),
    parent: (route) =>
      route.path
        ? tasksRoute({
            threadId: route.threadId,
            review: true,
            reviewScope: route.reviewScope,
            reviewNavigator: route.reviewNavigator,
            reviewViewer: route.reviewViewer,
            baseRef: route.baseRef,
          })
        : tasksRoute(),
  }),
  routeDefinition({
    id: "task-git-compare",
    kind: "compare",
    pattern: "/tasks/[threadId]/git/compare",
    query: GIT_COMPARE_QUERY,
    surface: "task-workspace",
    domain: "git",
    target: (route) => (cleanPath(route.path) ? "file" : "list"),
    params: { threadId: "string" },
    toRoute: ({ threadId }, query) => gitCompareRoute(threadId, query),
    parent: (route) =>
      route.path
        ? gitCompareRoute(route.threadId, {
            baseRef: route.baseRef,
            headRef: route.headRef,
          })
        : tasksRoute(),
  }),
  routeDefinition({
    id: "task-git-log",
    kind: "log",
    pattern: "/tasks/[threadId]/git/log",
    query: GIT_LOG_QUERY,
    surface: "task-workspace",
    domain: "git",
    target: (route) => (route.path ? "file" : route.sha ? "commit" : "list"),
    params: { threadId: "string" },
    toRoute: ({ threadId }, query) => gitLogRoute(threadId, query),
    parent: (route) => {
      if (route.path) {
        return gitLogRoute(route.threadId, {
          page: route.page,
          sha: route.sha,
        });
      }
      if (route.sha) {
        return gitLogRoute(route.threadId, { page: route.page });
      }
      return tasksRoute();
    },
  }),
  routeDefinition({
    id: "task-github-issues-list",
    kind: "issues",
    pattern: "/tasks/[threadId]/github/issues",
    query: PAGE_QUERY,
    surface: "task-workspace",
    domain: "github",
    target: "list",
    params: { threadId: "string" },
    toRoute: ({ threadId }, query) => githubIssuesRoute(threadId, query),
    parent: () => tasksRoute(),
  }),
  routeDefinition({
    id: "task-github-issues-detail",
    kind: "issues",
    pattern: "/tasks/[threadId]/github/issues/[number]",
    query: PAGE_QUERY,
    surface: "task-workspace",
    domain: "github",
    target: "detail",
    params: { threadId: "string", number: "positiveInteger" },
    toRoute: ({ threadId, number }, query) =>
      githubIssuesRoute(threadId, { ...query, number }),
    parent: (route) => githubIssuesRoute(route.threadId, { page: route.page }),
  }),
  routeDefinition({
    id: "task-github-pulls-list",
    kind: "pulls",
    pattern: "/tasks/[threadId]/github/pulls",
    query: PAGE_QUERY,
    surface: "task-workspace",
    domain: "github",
    target: "list",
    params: { threadId: "string" },
    toRoute: ({ threadId }, query) => githubPullsRoute(threadId, query),
    parent: () => tasksRoute(),
  }),
  routeDefinition({
    id: "task-github-pulls-detail",
    kind: "pulls",
    pattern: "/tasks/[threadId]/github/pulls/[number]",
    query: PAGE_QUERY,
    surface: "task-workspace",
    domain: "github",
    target: "detail",
    params: { threadId: "string", number: "positiveInteger" },
    toRoute: ({ threadId, number }, query) =>
      githubPullsRoute(threadId, { ...query, number }),
    parent: (route) => githubPullsRoute(route.threadId, { page: route.page }),
  }),
  routeDefinition({
    id: "task-github-pulls-files",
    kind: "pulls",
    pattern: "/tasks/[threadId]/github/pulls/[number]/files",
    query: PULL_FILES_QUERY,
    surface: "task-workspace",
    domain: "github",
    target: (route) => (cleanPath(route.path) ? "file" : "files"),
    params: { threadId: "string", number: "positiveInteger" },
    toRoute: ({ threadId, number }, query) =>
      githubPullsRoute(threadId, { ...query, number, files: true }),
    parent: (route) =>
      route.path
        ? githubPullsRoute(route.threadId, {
            page: route.page,
            number: route.number,
            files: true,
          })
        : githubPullsRoute(route.threadId, {
            page: route.page,
            number: route.number,
          }),
  }),
  routeDefinition({
    id: "global-tasks-detail",
    kind: "tasks",
    pattern: "/tasks/[threadId]",
    surface: "task-workspace",
    target: "detail",
    toRoute: ({ threadId }, query) => tasksRoute({ ...query, threadId }),
    matchesRoute: (route) =>
      route?.kind === "tasks" && Boolean(route.threadId) && !route.review,
    parent: () => tasksRoute(),
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
  return routeDefinitionFor(route)?.surface ?? "task-workspace";
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
    surface: config.surface ?? "task-workspace",
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
  const review = Boolean(options.review && options.threadId);
  return {
    kind: "tasks",
    new: Boolean(options.new),
    threadId: options.threadId ?? "",
    cwd: options.new ? taskCwd(options.cwd) : "",
    ...(review
      ? {
          review: true,
          reviewScope: enumValue(options.reviewScope, ["working", "branch"], "working"),
          reviewNavigator: enumValue(options.reviewNavigator, ["changes", "files"], "changes"),
          reviewViewer: enumValue(options.reviewViewer, ["diff", "source"], "diff"),
          path: safeRelativePath(options.path),
          baseRef: `${options.baseRef ?? ""}`,
        }
      : {}),
  };
}

function settingsRoute(section = "") {
  return {
    kind: "settings",
    section: ["appearance", "codex", "about"].includes(section)
      ? section
      : "",
  };
}

function gitCompareRoute(threadId, options = {}) {
  return {
    kind: "compare",
    threadId,
    baseRef: options.baseRef ?? "",
    headRef: options.headRef ?? "",
    path: safeRelativePath(options.path),
  };
}

function gitLogRoute(threadId, options = {}) {
  return {
    kind: "log",
    threadId,
    page: options.page ?? 1,
    sha: options.sha ?? "",
    path: safeRelativePath(options.path),
  };
}

function githubIssuesRoute(threadId, options = {}) {
  return {
    kind: "issues",
    threadId,
    page: options.page ?? 1,
    number: options.number ?? null,
  };
}

function githubPullsRoute(threadId, options = {}) {
  return {
    kind: "pulls",
    threadId,
    page: options.page ?? 1,
    number: options.number ?? null,
    files: Boolean(options.files),
    path: safeRelativePath(options.path),
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

function safeRelativePath(path) {
  const segments = `${path ?? ""}`.split("/");
  if (segments.some((segment) => segment === "..")) {
    return "";
  }
  return cleanPath(path);
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
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
