import assert from "node:assert/strict";
import test from "node:test";

import {
  promptWithAttachedFiles,
  uploadFileNames,
  uploadFolderName,
  uploadPath,
} from "./prompt-attachments.js";

test("a send's folder is named by when it was sent and four characters", () => {
  const values = [0, 0.5, 0.999, 0.1];
  const random = () => values.shift();

  assert.equal(
    uploadFolderName(new Date(2026, 8, 6, 5, 4, 3), random),
    "20260906-050403-0iz3",
  );
  assert.match(uploadFolderName(), /^\d{8}-\d{6}-[0-9a-z]{4}$/);
});

test("names that repeat within a send are numbered before their extension", () => {
  assert.deepEqual(
    uploadFileNames(["log.txt", "log.txt", "Log.txt", "notes", "notes", ".env", ".env"]),
    ["log.txt", "log-2.txt", "Log-3.txt", "notes", "notes-2", ".env", ".env-2"],
  );
  assert.deepEqual(
    uploadFileNames(["café.txt", "café.txt"]),
    ["café.txt", "café-2.txt"],
    "one name in two Unicode forms is one file on a Mac",
  );
});

test("a name the upload folder cannot hold is made into one it can", () => {
  assert.deepEqual(
    uploadFileNames(["a/b.txt", "back\\slash.txt", "line\nbreak.txt", "..", "", "."]),
    ["a_b.txt", "back_slash.txt", "line_break.txt", "file", "file-2", "file-3"],
  );
  const long = `${"x".repeat(300)}.log`;
  const [first, second] = uploadFileNames([long, long]);
  assert.equal(new TextEncoder().encode(first).length, 255);
  assert.ok(first.endsWith(".log"));
  assert.ok(second.endsWith("-2.log"));
  assert.equal(new TextEncoder().encode(second).length, 255);
  assert.notEqual(first, second);
});

test("the prompt ends with the paths of everything it carries", () => {
  const paths = [
    uploadPath("20260926-153012-a1b2", "server.log"),
    uploadPath("20260926-153012-a1b2", "shot.png"),
  ];

  assert.equal(
    promptWithAttachedFiles("Look at these", paths),
    "Look at these\n\nAttached files:\n" +
      "- .caffold/uploads/20260926-153012-a1b2/server.log\n" +
      "- .caffold/uploads/20260926-153012-a1b2/shot.png",
  );
  assert.equal(
    promptWithAttachedFiles("", paths.slice(0, 1)),
    "Attached files:\n- .caffold/uploads/20260926-153012-a1b2/server.log",
  );
});
