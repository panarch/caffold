import { installTaskLoopFixture } from "./task-loop-fixture.js";
import { installTaskReviewFixture } from "./task-review-fixture.js";
import { pngBytes } from "./png-fixture.js";

const BLUE = [37, 99, 235, 255];
const GREEN = [22, 163, 74, 255];
const TEAL = [15, 118, 110, 255];
const PURPLE = [124, 58, 237, 255];
const ORANGE = [245, 158, 11, 255];
const GREY = [100, 116, 139, 255];

const oid = (digit) => digit.repeat(40);

// The pictures each side of a change shows: a blob by its id, the working
// tree file by its path.
export const VISUAL_PICTURES = {
  blobs: {
    [oid("1")]: { type: "image/png", bytes: pngBytes(64, 40, () => BLUE) },
    [oid("2")]: { type: "image/png", bytes: pngBytes(32, 32, () => TEAL) },
    [oid("3")]: { type: "image/png", bytes: pngBytes(80, 20, () => GREY) },
    [oid("4")]: {
      type: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="60" height="20" fill="#2563eb"/></svg>',
      ),
    },
  },
  workingTree: {
    // Its right half changed from blue to green.
    "src/release-card.png": {
      type: "image/png",
      bytes: pngBytes(64, 40, (x) => (x < 32 ? BLUE : GREEN)),
    },
    "src/app-icon.png": { type: "image/png", bytes: pngBytes(64, 64, () => PURPLE) },
    "src/beta-badge.png": { type: "image/png", bytes: pngBytes(48, 20, () => ORANGE) },
    "src/logo.svg": {
      type: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="60" height="20" fill="#7c3aed"/></svg>',
      ),
    },
  },
};

const blob = (digit) => ({ source: "blob", oid: oid(digit) });
const WORKING_TREE = { source: "workingTree" };

// Each changed file with its status since the last commit, how it is
// staged, and the sides its diff compares.
const CHANGES = [
  ["src/release-card.png", "M", "unstaged", blob("1"), WORKING_TREE],
  ["src/app-icon.png", "M", "unstaged", blob("2"), WORKING_TREE],
  ["src/beta-badge.png", "A", "untracked", null, WORKING_TREE],
  ["src/spring-banner.png", "D", "unstaged", blob("3"), null],
  ["src/logo.svg", "M", "unstaged", blob("4"), WORKING_TREE],
  ["src/planner.rs", "M", "unstaged", null, null],
];

// Opens Integrated Review on a Task whose Working Tree changes these
// pictures, with `file` selected in `view`. The Git routes answer from the
// table above; `failingBlobs` answer as too large, and a test may change a
// working tree file.
export async function openVisualReview(
  page,
  { file, view = "visual", failingBlobs = [] },
) {
  await installTaskReviewFixture(page);
  const scenario = await installVisualChanges(page, failingBlobs);
  const taskScenario = await installTaskLoopFixture(page);
  await taskScenario.seedCompletedTask();
  await page.goto(`/tasks/${taskScenario.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?view=${view}&file=${encodeURIComponent(file)}`,
  );
  return {
    ...scenario,
    taskScenario,
    tasksPage,
    taskReview: tasksPage.locator("caffold-task-review"),
  };
}

async function installVisualChanges(page, failing) {
  const failingBlobs = new Set(failing);
  const workingTree = { ...VISUAL_PICTURES.workingTree };
  const requests = { blobs: [], images: [], versions: [] };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: 1,
        deletions: 1,
        files: CHANGES.map(([path, status, category]) => ({
          path,
          repoRelativePath: path.replace(/^src\//, ""),
          status,
          category,
          staged: false,
          unstaged: category === "unstaged",
          untracked: category === "untracked",
        })),
      }),
    }),
  );
  await page.route(/\/api\/git\/diff-versions(?:\?|$)/, (route) => {
    const address = new URL(route.request().url());
    const file = address.searchParams.get("file");
    requests.versions.push(file);
    const [, , , before, after] = CHANGES.find(([path]) => path === file);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind: address.searchParams.get("base"),
        before,
        after,
      }),
    });
  });
  await page.route(/\/api\/git\/blob(?:\?|$)/, (route) => {
    const blobId = new URL(route.request().url()).searchParams.get("oid");
    requests.blobs.push(blobId);
    const picture = VISUAL_PICTURES.blobs[blobId];
    if (!picture || failingBlobs.has(blobId)) {
      return route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "file_too_large", message: "file is too large" },
        }),
      });
    }
    return route.fulfill({
      contentType: picture.type,
      headers: { ETag: `"${blobId}"` },
      body: picture.bytes,
    });
  });
  await page.route(/\/api\/image(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const picture = workingTree[path];
    if (!picture) {
      return route.fallback();
    }
    requests.images.push(path);
    return route.fulfill({
      contentType: picture.type,
      headers: { ETag: `"${picture.version ?? "v1"}"` },
      body: picture.bytes,
    });
  });

  return {
    requests,
    // The file on disk changes and is named by another version.
    changeWorkingTree(path, bytes) {
      workingTree[path] = { type: "image/png", bytes, version: "v2" };
    },
  };
}
