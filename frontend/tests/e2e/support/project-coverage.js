export const VIEWPORT_PROJECTS = Object.freeze([
  "desktop",
  "foldable",
  "phone",
]);

export const SINGLE_RUN_PROJECTS = Object.freeze([
  "server-changes",
  "server-steady",
]);

export const ALL_VIEWPORTS_TAG = "@all-viewports";

export const SINGLE_RUN_TAGS = Object.freeze(
  SINGLE_RUN_PROJECTS.map((project) => `@${project}`),
);

export const VIEWPORT_COVERAGE_TAGS = Object.freeze([
  ALL_VIEWPORTS_TAG,
  ...SINGLE_RUN_TAGS,
  ...VIEWPORT_PROJECTS.map((project) => `@${project}`),
]);

// A test that can break by engine, as where a scrollport keeps its place or
// what a top-layer element covers, also carries `@webkit` beside its coverage
// tag. The WebKit project runs it once more in WebKit, in the desktop browser,
// so only coverage the desktop browser runs selects it there.
export const WEBKIT_TAG = "@webkit";

export const WEBKIT_PROJECT = "webkit";

export const DESKTOP_BROWSER_TAGS = Object.freeze([
  ALL_VIEWPORTS_TAG,
  "@desktop",
  ...SINGLE_RUN_TAGS,
]);

export function viewportCoveragePattern(project) {
  if (project === WEBKIT_PROJECT) {
    const desktopBrowser = DESKTOP_BROWSER_TAGS.map((tag) => tag.slice(1));
    return new RegExp(
      `^(?=.*${WEBKIT_TAG}\\b)(?=.*@(?:${desktopBrowser.join("|")})\\b)`,
    );
  }
  if (SINGLE_RUN_PROJECTS.includes(project)) {
    return new RegExp(`@${project}\\b`);
  }
  if (!VIEWPORT_PROJECTS.includes(project)) {
    throw new Error(`Unknown viewport project: ${project}`);
  }
  return new RegExp(`@(?:all-viewports|${project})\\b`);
}
