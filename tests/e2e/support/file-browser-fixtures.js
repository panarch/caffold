import { resolve } from "node:path";

export const LAST_DIRECTORY_KEY = `caffold:last-directory-path:${resolve("tests/fixtures/home")}`;
export const FILES_HOME_URL = "/files?cwd=.";
export const LONG_ROOT_FILE =
  "this-is-a-very-long-file-name-used-to-test-horizontal-scrolling-in-the-files-pane.md";
export const LONG_CHANGE_FILE =
  "src/planner/this-is-a-very-long-change-file-name-used-to-test-horizontal-scrolling-in-the-changes-pane.rs";
