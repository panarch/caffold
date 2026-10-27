import assert from "node:assert/strict";
import test from "node:test";

import {
  UPLOAD_DISCARD_EVENT as EVENT,
  UPLOAD_DISCARD_NODE as NODE,
  UploadDiscards,
  nextUploadDiscardNode,
} from "./upload-discards.js";

const ALLOWED = [
  [NODE.SENDING, EVENT.ANSWERED, NODE.SETTLED],
  [NODE.SENDING, EVENT.UNREACHABLE, NODE.WAITING],
  [NODE.WAITING, EVENT.REACHABLE, NODE.SENDING],
];
const FOLDER = "20261007-101500-a1b2";

test("every allowed edge leads where the folder goes next", () => {
  for (const [node, event, next] of ALLOWED) {
    assert.equal(nextUploadDiscardNode(node, event), next, `${node} --${event}-->`);
  }
});

test("every other event is refused where it does not belong", () => {
  const allowed = new Set(ALLOWED.map(([node, event]) => `${node}:${event}`));
  for (const node of Object.values(NODE)) {
    for (const event of Object.values(EVENT)) {
      if (!allowed.has(`${node}:${event}`)) {
        assert.equal(nextUploadDiscardNode(node, event), null, `${node} --${event}-->`);
      }
    }
  }
});

test("a discard that cannot reach Caffold goes again once Caffold answers", async () => {
  const caffold = caffoldServer();
  const discards = new UploadDiscards({ discard: caffold.discard });

  discards.discard("task", FOLDER);
  caffold.requests[0].reject(new TypeError("Failed to fetch"));
  await settled();
  assert.equal(caffold.requests.length, 1);

  discards.reachable();
  assert.deepEqual(
    caffold.requests.map(({ threadId, folder }) => [threadId, folder]),
    [["task", FOLDER], ["task", FOLDER]],
  );
  caffold.requests[1].reject(timedOut());
  await settled();

  discards.reachable();
  assert.equal(caffold.requests.length, 3);
  caffold.requests[2].resolve();
  await settled();

  discards.reachable();
  assert.equal(caffold.requests.length, 3);
});

test("any answer from Caffold settles a folder, a refusal included", async () => {
  const caffold = caffoldServer();
  const discards = new UploadDiscards({ discard: caffold.discard });

  discards.discard("task", FOLDER);
  discards.discard("task", "20261007-101501-c3d4");
  caffold.requests[0].resolve();
  caffold.requests[1].reject(Object.assign(new Error("gone"), { status: 409 }));
  await settled();

  discards.reachable();
  assert.equal(caffold.requests.length, 2);
});

test("a folder already being sent is not sent a second time", async () => {
  const caffold = caffoldServer();
  const discards = new UploadDiscards({ discard: caffold.discard });

  discards.discard("task", FOLDER);
  discards.discard("task", FOLDER);
  discards.reachable();
  assert.equal(caffold.requests.length, 1);

  caffold.requests[0].reject(new TypeError("Failed to fetch"));
  await settled();
  discards.reachable();
  discards.reachable();
  assert.equal(caffold.requests.length, 2);
});

// A Caffold whose answers the test gives one request at a time.
function caffoldServer() {
  const requests = [];
  return {
    requests,
    discard(threadId, folder) {
      return new Promise((resolve, reject) => {
        requests.push({ threadId, folder, resolve, reject });
      });
    },
  };
}

function timedOut() {
  return Object.assign(new Error("timed out"), { code: "request_timeout", status: 0 });
}

function settled() {
  return new Promise((resolve) => setImmediate(resolve));
}
