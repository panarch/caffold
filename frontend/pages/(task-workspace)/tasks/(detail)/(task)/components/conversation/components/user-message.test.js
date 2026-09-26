import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./user-message.js");
const message = registry.element("caffold-task-user-message").prototype;
after(() => registry.restore());

function uploadLine(index) {
  const properties = new Map();
  return {
    dataset: { uploadLine: `${index}` },
    style: {
      setProperty: (name, value) => properties.set(name, value),
    },
    progress: () => properties.get("--upload-progress"),
  };
}

function messageOwner({ deliveryState = "", lines = [], attachments } = {}) {
  const delivery = { textContent: "" };
  const owner = Object.assign(Object.create(message), {
    hidden: false,
    initialized: true,
    querySelector(selector) {
      if (selector.includes("task-user-message-delivery")) {
        return delivery;
      }
      return selector.includes("caffold-task-message-attachments")
        ? attachments ?? null
        : null;
    },
    querySelectorAll: (selector) =>
      selector.includes("[data-upload-line]") ? lines : [],
  });
  owner.ensureState();
  owner.presentation = { ...owner.presentation, deliveryState };
  return { owner, delivery };
}

test("says how far its files have gone and paints each line's share", () => {
  const lines = [uploadLine(0), uploadLine(1)];
  const { owner, delivery } = messageOwner({
    deliveryState: "uploading",
    lines,
  });

  owner.paintDelivery();
  assert.equal(delivery.textContent, "Uploading 0%");
  assert.deepEqual(lines.map((line) => line.progress()), ["0", "0"]);

  owner.setUploadProgress({ percent: 42, lines: [0.75, 0] });
  assert.equal(delivery.textContent, "Uploading 42%");
  assert.deepEqual(lines.map((line) => line.progress()), ["0.75", "0"]);
});

test("names each later delivery state and none once the message is sent", () => {
  for (const [deliveryState, label] of [
    ["sending", "Sending..."],
    ["accepted", "Accepted - syncing..."],
    ["outcomeUnknown", "Delivery unconfirmed"],
    ["", ""],
  ]) {
    const { owner, delivery } = messageOwner({ deliveryState });
    delivery.textContent = "stale";
    owner.paintDelivery();
    assert.equal(delivery.textContent, label, deliveryState);
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
  const { owner } = messageOwner({ attachments });
  const conversation = { id: "conversation" };

  const scope = owner.actionHintScope({
    scopeId: "message:a",
    clipRoots: [conversation],
  });
  assert.deepEqual(scope.targets, [target]);
  assert.deepEqual(scope.mutationRoots, [attachments]);
  assert.equal(attachments.options.scopeId, "message:a:attachments");
  assert.deepEqual(attachments.options.clipRoots, [owner, conversation]);

  owner.hidden = true;
  assert.deepEqual(owner.actionHintScope({ scopeId: "message:a" }).targets, []);
});

test("leaves its DOM alone when the same message is reported again", () => {
  let updates = 0;
  const owner = Object.assign(Object.create(message), {
    initialized: true,
    update() {
      updates += 1;
    },
  });
  const snapshot = {
    text: "Look",
    attachments: [{ src: "data:image/png;base64,AAAA", name: "shot.png" }],
    deliveryState: "sending",
    time: "",
    uploadLines: [],
  };

  assert.equal(owner.setSnapshot(snapshot), true);
  assert.equal(owner.setSnapshot(structuredClone(snapshot)), false);
  assert.equal(owner.setSnapshot({ ...snapshot, deliveryState: "accepted" }), true);
  assert.equal(updates, 2);
});
