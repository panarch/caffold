import assert from "node:assert/strict";
import test from "node:test";

import {
  completeTypedDirectoryPath,
  directoryPathDisplay,
  directoryPathEditingText,
  matchesTypedName,
  readTypedDirectoryPath,
} from "./directory-path.js";

const MAC = { root: "/", homePath: "Users/taehoon" };
const ROOTED = { root: "/srv/work", homePath: null };

test("a directory below the filesystem root reads as an absolute or home path", () => {
  assert.equal(directoryPathDisplay("Users/taehoon", MAC), "~");
  assert.equal(directoryPathDisplay("Users/taehoon/Workspace/rust", MAC), "~/Workspace/rust");
  assert.equal(directoryPathDisplay("Users/taehoonx", MAC), "/Users/taehoonx");
  assert.equal(directoryPathDisplay("private/tmp", MAC), "/private/tmp");
  assert.equal(directoryPathDisplay("", MAC), "/");
  assert.equal(directoryPathDisplay("Users", { root: "/", homePath: "" }), "/Users");
});

test("a directory on another server root reads relative to that root", () => {
  assert.equal(directoryPathDisplay("Workspace/lumen", ROOTED), "Workspace/lumen");
  assert.equal(directoryPathDisplay(".", ROOTED), ".");
  assert.equal(directoryPathDisplay("", {}), ".");
});

test("an edit starts from the shown path ending in a slash", () => {
  assert.equal(directoryPathEditingText("Users/taehoon", MAC), "~/");
  assert.equal(directoryPathEditingText("Users/taehoon/Workspace", MAC), "~/Workspace/");
  assert.equal(directoryPathEditingText("", MAC), "/");
  assert.equal(directoryPathEditingText("Workspace/lumen", ROOTED), "Workspace/lumen/");
  assert.equal(directoryPathEditingText("", ROOTED), "");
});

test("typed text names the folder to list and the start of a name in it", () => {
  assert.deepEqual(readTypedDirectoryPath("~", MAC), { folder: "Users/taehoon", name: "" });
  assert.deepEqual(readTypedDirectoryPath("~/", MAC), { folder: "Users/taehoon", name: "" });
  assert.deepEqual(
    readTypedDirectoryPath("~/Workspace/rust/gl", MAC),
    { folder: "Users/taehoon/Workspace/rust", name: "gl" },
  );
  assert.deepEqual(
    readTypedDirectoryPath(" /private//tmp/ ", MAC),
    { folder: "private/tmp", name: "" },
  );
  assert.deepEqual(readTypedDirectoryPath("/", MAC), { folder: "", name: "" });
  assert.deepEqual(readTypedDirectoryPath("~/.c", MAC), { folder: "Users/taehoon", name: ".c" });
  assert.deepEqual(
    readTypedDirectoryPath("~/./Workspace/", MAC),
    { folder: "Users/taehoon/Workspace", name: "" },
  );
  assert.deepEqual(readTypedDirectoryPath("src/ap", ROOTED), { folder: "src", name: "ap" });
  assert.deepEqual(readTypedDirectoryPath("", ROOTED), { folder: "", name: "" });
});

test("typed text that cannot name a folder says why", () => {
  assert.deepEqual(readTypedDirectoryPath("Workspace", MAC), {
    error: "Start the path with / or ~.",
  });
  assert.deepEqual(readTypedDirectoryPath("Workspace", { root: "/", homePath: null }), {
    error: "Start the path with /.",
  });
  assert.deepEqual(readTypedDirectoryPath("~/x", { root: "/", homePath: null }), {
    error: "This server has no home directory. Start the path with /.",
  });
  assert.deepEqual(readTypedDirectoryPath("~/Workspace/../x", MAC), {
    error: "A path cannot contain “..”.",
  });
  assert.deepEqual(readTypedDirectoryPath("/srv/work/src", ROOTED), {
    error: "Type the path inside the server root, without / or ~ in front.",
  });
});

test("Tab completion keeps what was typed up to its last slash", () => {
  assert.equal(completeTypedDirectoryPath("~/Workspace/rust/gl", "glues"), "~/Workspace/rust/glues/");
  assert.equal(completeTypedDirectoryPath("~/Workspace/", "rust"), "~/Workspace/rust/");
  assert.equal(completeTypedDirectoryPath("~", "Workspace"), "~/Workspace/");
  assert.equal(completeTypedDirectoryPath("sr", "src"), "src/");
});

test("names match the typed start without regard to case", () => {
  assert.equal(matchesTypedName("Gluesql", "gl"), true);
  assert.equal(matchesTypedName(".cache", "."), true);
  assert.equal(matchesTypedName("cache", "."), false);
  assert.equal(matchesTypedName("anything", ""), true);
});
