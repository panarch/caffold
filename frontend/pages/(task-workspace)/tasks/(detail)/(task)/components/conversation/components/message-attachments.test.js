import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { TASK_IMAGE_PREVIEW_EVENT } = await import(
  "../../../../../components/image-preview-dialog.js"
);
await import("./message-attachments.js");
const attachments = registry
  .element("caffold-task-message-attachments")
  .prototype;
after(() => registry.restore());

function previewButton(name) {
  return {
    clicks: 0,
    dataset: {},
    getAttribute: (attribute) =>
      attribute === "aria-label" ? `Preview ${name}` : null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

function attachmentsHost(properties = {}) {
  return Object.assign(Object.create(attachments), {
    connected: true,
    hidden: false,
    initialized: true,
    isConnected: true,
    attachments: [],
    ...properties,
  });
}

test("provides one Preview action for each picture it can open", () => {
  const first = previewButton("first.png");
  const second = previewButton("second.png");
  let buttons = [first, second];
  const host = attachmentsHost({ previewButtons: () => buttons });
  const message = { id: "message" };

  const scope = host.actionHintScope({
    scopeId: "message:a:attachments",
    clipRoots: [message],
  });
  assert.deepEqual(
    scope.targets.map(({ id, label }) => ({ id, label })),
    [
      { id: "message:a:attachments:preview:1", label: "Preview first.png" },
      { id: "message:a:attachments:preview:2", label: "Preview second.png" },
    ],
  );
  assert.deepEqual(scope.mutationRoots, [host]);
  for (const target of scope.targets) {
    assert.equal(target.invalidationOwner, host);
    assert.deepEqual(target.clipRoots, [host, message]);
    assert.equal(target.isActionable(), true);
  }
  scope.targets[1].activate();
  assert.deepEqual([first.clicks, second.clicks], [0, 1]);

  buttons = [previewButton("first.png"), second];
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(scope.targets[1].isActionable(), true);
});

test("withholds its actions while hidden or disconnected", () => {
  const button = previewButton("shot.png");
  const host = attachmentsHost({ previewButtons: () => [button] });
  const [target] = host.actionHintScope({ scopeId: "message:a" }).targets;

  host.hidden = true;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(host.actionHintScope({ scopeId: "message:a" }).targets, []);
  host.hidden = false;

  host.connected = false;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(host.actionHintScope({ scopeId: "message:a" }).targets, []);
});

test("asks for a preview of the picture that was clicked", () => {
  const button = previewButton("second.png");
  button.dataset.attachmentIndex = "1";
  const requests = [];
  const host = attachmentsHost({
    attachments: [
      { src: "data:image/png;base64,AAAA", name: "first.png" },
      { src: "data:image/png;base64,BBBB", name: "second.png" },
    ],
    previewButtons: () => [button],
    dispatchEvent(event) {
      requests.push({ type: event.type, detail: event.detail });
      return true;
    },
  });

  host.handleClick({ target: { closest: () => button } });
  host.handleClick({ target: { closest: () => previewButton("elsewhere.png") } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, TASK_IMAGE_PREVIEW_EVENT);
  assert.equal(requests[0].detail.src, "data:image/png;base64,BBBB");
  assert.equal(requests[0].detail.name, "second.png");
});

test("keeps its pictures when the same ones are reported again", () => {
  let renders = 0;
  const host = attachmentsHost({
    render() {
      renders += 1;
    },
  });
  const pictures = [{ src: "data:image/png;base64,AAAA", name: "shot.png" }];

  assert.equal(host.setSnapshot({ attachments: pictures }), true);
  assert.equal(host.setSnapshot({ attachments: [{ ...pictures[0] }] }), false);
  assert.equal(renders, 1);
  assert.equal(
    host.setSnapshot({ attachments: [{ ...pictures[0], name: "renamed.png" }] }),
    true,
  );
  assert.equal(renders, 2);
});
