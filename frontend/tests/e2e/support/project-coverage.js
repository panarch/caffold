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

export function viewportCoveragePattern(project) {
  if (SINGLE_RUN_PROJECTS.includes(project)) {
    return new RegExp(`@${project}\\b`);
  }
  if (!VIEWPORT_PROJECTS.includes(project)) {
    throw new Error(`Unknown viewport project: ${project}`);
  }
  return new RegExp(`@(?:all-viewports|${project})\\b`);
}
