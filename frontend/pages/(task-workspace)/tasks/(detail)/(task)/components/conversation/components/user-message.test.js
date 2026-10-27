import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./user-message.js");
const message = registry.element("caffold-task-user-message").prototype;
after(() => registry.restore());

function messageOwner(properties = {}) {
  return Object.create(message, Object.getOwnPropertyDescriptors({
    hidden: false,
    text: "",
    attachments: [],
    deliveryState: "",
    time: "",
    uploadLines: [],
    uploadProgress: null,
    attachmentList: { value: undefined },
    performUpdate() {},
    ...properties,
  }));
}

function delivery(owner) {
  return templateHtml(owner.render()).match(
    /<span class="task-user-message-delivery">([^<]*)<\/span>/,
  )[1];
}

test("says how far its files have gone and paints each line's share", () => {
  const uploading = {
    text: "Look\n- .caffold/uploads/a/server.log\n- .caffold/uploads/a/shot.png",
    deliveryState: "uploading",
    uploadLines: [
      { path: ".caffold/uploads/a/server.log", done: false },
      { path: ".caffold/uploads/a/shot.png", done: true },
    ],
  };
  const progress = (owner) =>
    [...templateHtml(owner.render()).matchAll(/--upload-progress: ([\d.]+)/g)].map(
      ([, share]) => share,
    );

  const before = messageOwner(uploading);
  assert.equal(delivery(before), "Uploading 0%");
  assert.deepEqual(progress(before), ["0", "0"]);

  const after = messageOwner({
    ...uploading,
    uploadProgress: { percent: 42, lines: [0.75, 0] },
  });
  assert.equal(delivery(after), "Uploading 42%");
  assert.deepEqual(progress(after), ["0.75", "0"]);
  // A file that has gone up keeps its line without a bar.
  assert.equal(
    [...templateHtml(after.render()).matchAll(/task-user-message-upload-bar/g)].length,
    1,
  );
});

test("names each later delivery state and none once the message is sent", () => {
  for (const [deliveryState, label] of [
    ["sending", "Sending..."],
    ["accepted", "Accepted - syncing..."],
    ["outcomeUnknown", "Delivery unconfirmed"],
    ["", ""],
  ]) {
    assert.equal(delivery(messageOwner({ deliveryState })), label, deliveryState);
  }
});

test("offers only its attachment list's actions", () => {
  const target = { id: "message:a:attachments:preview:1" };
  const attachments = {
    actionHintScope(options) {
      this.options = options;
      return { targets: [target], mutationRoots: [this] };
    },
  };
  const owner = messageOwner({ attachmentList: { value: attachments } });
  const conversation = { id: "conversation" };

  const scope = owner.actionHintScope({
    scopeId: "message:a",
    clipRoots: [conversation],
  });
  assert.deepEqual(scope.targets, [target]);
  assert.deepEqual(scope.mutationRoots, [attachments]);
  assert.equal(attachments.options.scopeId, "message:a:attachments");
  assert.deepEqual(attachments.options.clipRoots, [owner, conversation]);
});
