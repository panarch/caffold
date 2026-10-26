// What TypeScript modules use from navigation-routes.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export function parseLinkRoute(href: string): { kind: string } | null;

// A route an address names; the fields beside `kind` depend on it.
export interface ParsedRoute {
  kind: string;
  threadId?: string;
  sectionId?: string;
  section?: string;
  [field: string]: unknown;
}

export function parseRoute(url?: string): ParsedRoute | null;

export function routeEquals(
  left: { kind: string; [field: string]: unknown },
  right: { kind: string; [field: string]: unknown },
): boolean;

// The address of a route, whose other fields depend on its kind.
export function routeUrl(route: {
  kind: string;
  [field: string]: unknown;
}): string;

export function routeMode(
  route: { kind?: string } | null | undefined,
): string | null;

// The workspace tab a route belongs to.
export function routeTab(
  route: { kind?: string } | null | undefined,
): "tasks" | "notes" | "settings";

// What a route opens within its surface, such as New Task or a Task's
// review, or null.
export function routeTarget(
  route: { kind?: string } | null | undefined,
): string | null;

// The workspace domain a route shows, such as Git or GitHub, or null.
export function routeDomain(
  route: { kind?: string } | null | undefined,
): string | null;

// A Section's Detail route, with each field at the value its surface reads.
export interface SectionDetailRoute {
  kind: "tasks";
  new: false;
  threadId: "";
  cwd: "";
  sectionId: string;
  sectionSurface: "new" | "review" | "git" | "github" | "terminal";
  sectionTool: string;
  reviewScope: string;
  reviewNavigator: string;
  reviewViewer: string;
  path: string;
  line: number | null;
  baseRef: string;
  headRef: string;
  page: number;
  sha: string;
  number: number | null;
  files: boolean;
}

// The Section route the fields name, or null without a Section.
export function sectionDetailRoute(
  options?: Record<string, unknown> | null,
): SectionDetailRoute | null;
