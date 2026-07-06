const PAGE_QUERY = [{ name: "page", key: "page", type: "positiveInteger", defaultValue: 1 }];
const COMPARE_QUERY = [
  { name: "base", key: "baseRef", defaultValue: "" },
  { name: "head", key: "headRef", defaultValue: "" },
];

const ROUTE_DEFINITIONS = [
  routeDefinition({
    id: "project-root",
    kind: "files",
    pattern: "/projects/[projectId]",
    target: "list",
    canonical: false,
    toRoute: ({ projectId }) => filesRoute(projectId),
  }),
  routeDefinition({
    id: "files-list",
    kind: "files",
    pattern: "/projects/[projectId]/files",
    target: "list",
    toRoute: ({ projectId }) => filesRoute(projectId),
  }),
  routeDefinition({
    id: "files-path",
    kind: "files",
    pattern: "/projects/[projectId]/files/[...path]",
    target: "path",
    toRoute: ({ projectId, path }) => filesRoute(projectId, path),
    parent: (route) => filesRoute(route.projectId, parentPath(route.path)),
  }),
  routeDefinition({
    id: "diff-list",
    kind: "diff",
    pattern: "/projects/[projectId]/diff",
    domain: "git",
    target: "list",
    toRoute: ({ projectId }) => diffRoute(projectId),
    parent: filesRootRoute,
  }),
  routeDefinition({
    id: "diff-file",
    kind: "diff",
    pattern: "/projects/[projectId]/diff/[...path]",
    domain: "git",
    target: "file",
    toRoute: ({ projectId, path }) => diffRoute(projectId, path),
    parent: (route) => diffRoute(route.projectId),
  }),
  routeDefinition({
    id: "compare-list",
    kind: "compare",
    pattern: "/projects/[projectId]/compare",
    query: COMPARE_QUERY,
    domain: "git",
    target: "list",
    toRoute: ({ projectId }, query) => compareRoute(projectId, query),
    parent: filesRootRoute,
  }),
  routeDefinition({
    id: "compare-file",
    kind: "compare",
    pattern: "/projects/[projectId]/compare/[...path]",
    query: COMPARE_QUERY,
    domain: "git",
    target: "file",
    toRoute: ({ projectId, path }, query) => compareRoute(projectId, { ...query, path }),
    parent: (route) =>
      compareRoute(route.projectId, {
        baseRef: route.baseRef,
        headRef: route.headRef,
      }),
  }),
  routeDefinition({
    id: "log-list",
    kind: "log",
    pattern: "/projects/[projectId]/log",
    query: PAGE_QUERY,
    domain: "git",
    target: "list",
    toRoute: ({ projectId }, query) => logRoute(projectId, query),
    parent: filesRootRoute,
  }),
  routeDefinition({
    id: "log-commit",
    kind: "log",
    pattern: "/projects/[projectId]/log/[sha]",
    query: PAGE_QUERY,
    domain: "git",
    target: "commit",
    toRoute: ({ projectId, sha }, query) => logRoute(projectId, { ...query, sha }),
    parent: (route) => logRoute(route.projectId, { page: route.page }),
  }),
  routeDefinition({
    id: "log-file",
    kind: "log",
    pattern: "/projects/[projectId]/log/[sha]/[...path]",
    query: PAGE_QUERY,
    domain: "git",
    target: "file",
    toRoute: ({ projectId, sha, path }, query) => logRoute(projectId, { ...query, sha, path }),
    parent: (route) => logRoute(route.projectId, { page: route.page, sha: route.sha }),
  }),
  routeDefinition({
    id: "issues-list",
    kind: "issues",
    pattern: "/projects/[projectId]/issues",
    query: PAGE_QUERY,
    domain: "github",
    target: "list",
    toRoute: ({ projectId }, query) => issuesRoute(projectId, query),
    parent: filesRootRoute,
  }),
  routeDefinition({
    id: "issues-detail",
    kind: "issues",
    pattern: "/projects/[projectId]/issues/[number]",
    query: PAGE_QUERY,
    domain: "github",
    target: "detail",
    params: { number: "positiveInteger" },
    toRoute: ({ projectId, number }, query) => issuesRoute(projectId, { ...query, number }),
    parent: (route) => issuesRoute(route.projectId, { page: route.page }),
  }),
  routeDefinition({
    id: "pulls-list",
    kind: "pulls",
    pattern: "/projects/[projectId]/pulls",
    query: PAGE_QUERY,
    domain: "github",
    target: "list",
    toRoute: ({ projectId }, query) => pullsRoute(projectId, query),
    parent: filesRootRoute,
  }),
  routeDefinition({
    id: "pulls-detail",
    kind: "pulls",
    pattern: "/projects/[projectId]/pulls/[number]",
    query: PAGE_QUERY,
    domain: "github",
    target: "detail",
    params: { number: "positiveInteger" },
    toRoute: ({ projectId, number }, query) => pullsRoute(projectId, { ...query, number }),
    parent: (route) => pullsRoute(route.projectId, { page: route.page }),
  }),
  routeDefinition({
    id: "pulls-files",
    kind: "pulls",
    pattern: "/projects/[projectId]/pulls/[number]/files",
    query: PAGE_QUERY,
    domain: "github",
    target: "files",
    params: { number: "positiveInteger" },
    toRoute: ({ projectId, number }, query) =>
      pullsRoute(projectId, { ...query, number, files: true }),
    parent: (route) => pullsRoute(route.projectId, { page: route.page, number: route.number }),
  }),
  routeDefinition({
    id: "pulls-file",
    kind: "pulls",
    pattern: "/projects/[projectId]/pulls/[number]/files/[...path]",
    query: PAGE_QUERY,
    domain: "github",
    target: "file",
    params: { number: "positiveInteger" },
    toRoute: ({ projectId, number, path }, query) =>
      pullsRoute(projectId, {
        ...query,
        number,
        files: true,
        path,
      }),
    parent: (route) =>
      pullsRoute(route.projectId, {
        page: route.page,
        number: route.number,
        files: true,
      }),
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
  return routeDefinitionFor(route)?.target ?? null;
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

  if (hasToken(definition, "rest", "path") !== Boolean(cleanPath(route.path))) {
    return false;
  }

  if (hasToken(definition, "param", "sha") !== Boolean(route.sha)) {
    return false;
  }

  if (hasToken(definition, "param", "number") !== Boolean(route.number)) {
    return false;
  }

  if (definition.kind === "pulls") {
    const expectsFilesTarget = definition.target === "files" || definition.target === "file";
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

function filesRoute(projectId, path = "") {
  return { kind: "files", projectId, path: cleanPath(path) };
}

function diffRoute(projectId, path = "") {
  return { kind: "diff", projectId, path: cleanPath(path) };
}

function compareRoute(projectId, options = {}) {
  return {
    kind: "compare",
    projectId,
    baseRef: options.baseRef ?? "",
    headRef: options.headRef ?? "",
    path: cleanPath(options.path),
  };
}

function logRoute(projectId, options = {}) {
  return {
    kind: "log",
    projectId,
    page: options.page ?? 1,
    sha: options.sha ?? "",
    path: cleanPath(options.path),
  };
}

function issuesRoute(projectId, options = {}) {
  return {
    kind: "issues",
    projectId,
    page: options.page ?? 1,
    number: options.number ?? null,
  };
}

function pullsRoute(projectId, options = {}) {
  return {
    kind: "pulls",
    projectId,
    page: options.page ?? 1,
    number: options.number ?? null,
    files: Boolean(options.files),
    path: cleanPath(options.path),
  };
}

function filesRootRoute(route) {
  return filesRoute(route.projectId);
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
