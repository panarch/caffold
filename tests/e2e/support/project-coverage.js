export const VIEWPORT_PROJECTS = Object.freeze([
  "desktop",
  "foldable",
  "phone",
]);

export const ALL_VIEWPORTS_TAG = "@all-viewports";

export const VIEWPORT_COVERAGE_TAGS = Object.freeze([
  ALL_VIEWPORTS_TAG,
  ...VIEWPORT_PROJECTS.map((project) => `@${project}`),
]);

export function viewportCoveragePattern(project) {
  if (!VIEWPORT_PROJECTS.includes(project)) {
    throw new Error(`Unknown viewport project: ${project}`);
  }
  return new RegExp(`@(?:all-viewports|${project})\\b`);
}
