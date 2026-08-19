import { fileURLToPath } from "node:url";

// The npm package lives in frontend/, so the working directory of a test run is
// frontend/ rather than the repository root. Suites that reach repository-owned
// paths — fixtures, the Cargo target directory, checkouts — anchor to this
// value instead of the working directory.
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function repositoryPath(...segments) {
  return fileURLToPath(new URL(segments.join("/"), `file://${repositoryRoot}`));
}
