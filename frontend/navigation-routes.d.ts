// What TypeScript modules use from navigation-routes.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export function parseLinkRoute(href: string): { kind: string } | null;

// The address of a route, whose other fields depend on its kind.
export function routeUrl(route: {
  kind: string;
  [field: string]: unknown;
}): string;

export function routeMode(
  route: { kind?: string } | null | undefined,
): string | null;
