import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { updateTaskFrom, updateTaskPrompt } = await import("./update-task-dialog.js");
const dialog = registry.element("caffold-update-task-dialog").prototype;
after(() => registry.restore());

const COMMAND =
  '"/Applications/Caffold Server.app/Contents/Resources/caffold" update --app "/Applications/Caffold Server.app" --data-dir "/Users/me/Library/Application Support/Caffold/data" --port 5178';

const STATUS = {
  version: "0.18.2",
  latestRelease: { version: "0.18.3", url: "https://example.test" },
  updateAvailable: true,
  updateTask: {
    cwd: "Users/me/Library/Application Support/Caffold/data/caffold-updates",
    command: COMMAND,
  },
};

test("starts an update only for one the server offers and none is running", () => {
  assert.deepEqual(updateTaskFrom(STATUS), {
    to: "0.18.3",
    cwd: "Users/me/Library/Application Support/Caffold/data/caffold-updates",
    command: COMMAND,
  });
  assert.equal(updateTaskFrom({ ...STATUS, updateTask: undefined }), null);
  assert.equal(updateTaskFrom({ ...STATUS, latestRelease: undefined }), null);
  assert.equal(
    updateTaskFrom({ ...STATUS, runningAttempt: { id: "a", outcome: "running" } }),
    null,
  );
  assert.equal(updateTaskFrom(null), null);
});

test("asks the agent to name the Task, run the command, and recover", () => {
  assert.equal(
    updateTaskPrompt({ to: "0.18.3", command: COMMAND }),
    [
      "Update Caffold on this Mac to 0.18.3.",
      "",
      '1. Name this Task exactly "Update Caffold to 0.18.3".',
      "2. Run this command and wait for it to finish. It can take several minutes, and Caffold restarts while it runs:",
      "",
      "   ```",
      `   ${COMMAND}`,
      "   ```",
      "",
      "3. Report the result in one or two sentences.",
      "",
      'If the command is cut off, the update keeps going on its own: follow attempts/<latest>/attempt.json in this directory until its outcome is no longer "running". If it reports that the restore failed, read that attempt\'s attempt.json and log.txt, find out why Caffold is not running, and bring a working Caffold back. Do not change anything unrelated to this update.',
    ].join("\n"),
  );
});

function dialogHost({ accept = true, completion = Promise.resolve({}) } = {}) {
  const events = [];
  const closes = [];
  const host = {
    pending: false,
    error: null,
    createRequestId: 0,
    update: { to: "0.18.3", cwd: STATUS.updateTask.cwd, command: COMMAND },
    turnOptions: () => ({
      readyForSubmission: () => true,
      submissionOptions: () => ({
        provider: "codex",
        model: "gpt-6",
        effort: "high",
        fastMode: false,
        permissionMode: "fullAccess",
      }),
      resetFastMode() {},
    }),
    dialog: () => ({ close: (value) => closes.push(value) }),
    patch() {},
    dispatchEvent(event) {
      events.push(event);
      if (accept) {
        event.detail.accepted = true;
        event.detail.completion = completion;
      }
    },
  };
  return { host, events, closes };
}

test("hands the Task to whoever creates Tasks and closes once it exists", async () => {
  const { host, events, closes } = dialogHost();

  await dialog.startUpdate.call(host);

  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "caffold:task-create-intent");
  assert.equal(event.bubbles, true);
  assert.equal(event.detail.type, "start");
  assert.equal(event.detail.request.cwd, STATUS.updateTask.cwd);
  assert.equal(event.detail.request.permissionMode, "fullAccess");
  assert.equal(
    event.detail.request.titleSource,
    updateTaskPrompt({ to: "0.18.3", command: COMMAND }),
  );
  assert.equal(event.detail.submission.prompt, event.detail.request.titleSource);
  assert.match(event.detail.submission.submissionId, /^caffold-update:\d+:1$/);
  assert.deepEqual(event.detail.submission.images, []);
  assert.deepEqual(closes, ["started"]);
  assert.equal(host.pending, false);
});

test("stays open with the reason when the Task could not start", async () => {
  const refused = dialogHost({ accept: false });
  await dialog.startUpdate.call(refused.host);
  assert.equal(refused.host.error.message, "Another Task is still being created.");
  assert.deepEqual(refused.closes, []);

  const failed = dialogHost({ completion: Promise.reject(new Error("offline")) });
  await dialog.startUpdate.call(failed.host);
  assert.equal(failed.host.error.message, "offline");
  assert.equal(failed.host.pending, false);
  assert.deepEqual(failed.closes, []);
});

test("renders the agreed text and two buttons", () => {
  const owner = { innerHTML: "" };
  dialog.render.call(owner);

  assert.match(
    owner.innerHTML,
    /Running Tasks keep going while Caffold restarts\. Claude sessions stop if it takes more than 10 minutes\. Open terminals close\./,
  );
  assert.match(
    owner.innerHTML,
    /To let the agent recover Caffold even if the restore fails, choose the mode that allows everything \(Full access or Allow all\)\. Other modes can stop at the update command, and no one can answer approvals while Caffold restarts, including Ask Jev first\./,
  );
  assert.match(owner.innerHTML, />Cancel</);
  assert.match(owner.innerHTML, />Start Update</);
  assert.equal(
    [...owner.innerHTML.matchAll(/<caffold-keyboard-navigation-presentation>/g)].length,
    1,
  );
});
