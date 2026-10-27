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
const Attachments = registry.element("caffold-task-message-attachments");
const attachments = Attachments.prototype;
after(() => registry.restore());

function attachmentsHost(properties = {}) {
  return Object.create(attachments, {
    ...Object.getOwnPropertyDescriptors({
      hidden: false,
      isConnected: true,
      attachments: [],
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

test("asks for a preview of the picture that was clicked", () => {
  const requests = [];
  const host = attachmentsHost({
    attachments: [
      { src: "data:image/png;base64,AAAA", name: "first.png" },
      { src: "data:image/png;base64,BBBB", name: "second.png" },
    ],
    dispatchEvent(event) {
      requests.push({ type: event.type, detail: event.detail });
      return true;
    },
  });

  host.preview(1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, TASK_IMAGE_PREVIEW_EVENT);
  assert.equal(requests[0].detail.src, "data:image/png;base64,BBBB");
  assert.equal(requests[0].detail.name, "second.png");
});

test("keeps its pictures when the same ones are reported again", () => {
  const { hasChanged } = Attachments.getPropertyOptions("attachments");
  const pictures = [{ src: "data:image/png;base64,AAAA", name: "shot.png" }];

  assert.equal(hasChanged([{ ...pictures[0] }], pictures), false);
  assert.equal(hasChanged([{ ...pictures[0], name: "renamed.png" }], pictures), true);
});

// A thumbnail as rendered: in its box, the picture hidden beside its loading
// phrase.
function picture(source) {
  const loading = { hidden: false };
  const listeners = new Map();
  const box = {};
  const image = {
    dataset: { attachmentSource: source },
    hidden: true,
    loading,
    box,
    parentElement: box,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    hasAttribute(name) {
      return this[name] !== undefined;
    },
    removeAttribute(name) {
      delete this[name];
    },
    nextElementSibling: loading,
  };
  return image;
}

function watchedHost(pictures) {
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      observers.push(this);
    }
    observe(target) {
      this.observed.add(target);
    }
    unobserve(target) {
      this.observed.delete(target);
    }
    disconnect() {
      this.observed.clear();
    }
  };
  const host = attachmentsHost({
    attachments: pictures.map(() => ({})),
    fetchedPictures: new Map(),
    watchedBoxes: new Map(),
    pictures: { get: (key) => pictures[Number(key)] },
  });
  return { host, observers };
}

async function settle() {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("fetches a picture only once it nears the viewport", async (t) => {
  const near = picture("/api/task-image?path=%2Ftmp%2Fnear.png");
  const far = picture("/api/task-image?path=%2Ftmp%2Ffar.png");
  const { host, observers } = watchedHost([near, far]);
  const fetched = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/png" },
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete globalThis.IntersectionObserver;
  });

  host.watchPictures();
  const [observer] = observers;
  assert.deepEqual([...observer.observed], [near.box, far.box], "each picture is watched through its box");
  assert.equal(observer.options.rootMargin, "2500px 0px");
  assert.equal(observer.options.scrollMargin, "2500px 0px");

  observer.callback([
    { target: near.box, isIntersecting: true },
    { target: far.box, isIntersecting: false },
  ]);
  await settle();

  assert.deepEqual(fetched, ["/api/task-image?path=%2Ftmp%2Fnear.png"]);
  assert.match(near.src, /^blob:/);
  assert.equal(far.src, undefined);
  assert.deepEqual([...observer.observed], [far.box], "a fetched picture is no longer watched");

  assert.equal(near.hidden, true, "the picture stays hidden until it is drawn");
  assert.equal(near.loading.hidden, false);
  near.dispatch("load");
  assert.equal(near.hidden, false);
  assert.equal(near.loading.hidden, true);
  assert.equal(far.hidden, true);
  assert.equal(far.loading.hidden, false);
});

test("stops saying it is loading when a picture cannot be fetched", async (t) => {
  const missing = picture("/api/task-image?path=%2Ftmp%2Fmissing.png");
  const { host, observers } = watchedHost([missing]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete globalThis.IntersectionObserver;
  });

  host.watchPictures();
  observers[0].callback([{ target: missing.box, isIntersecting: true }]);
  await settle();

  assert.equal(missing.src, undefined);
  assert.equal(missing.loading.hidden, true);
});

test("lets go of its pictures when it leaves, so they are fetched again on return", async () => {
  const shown = picture("/api/task-image?path=%2Ftmp%2Fshown.png");
  const arriving = picture("/api/task-image?path=%2Ftmp%2Farriving.png");
  const { host } = watchedHost([shown, arriving]);
  const shownFetch = new AbortController();
  const arrivingFetch = new AbortController();
  shown.src = URL.createObjectURL(new Blob([new Uint8Array([1])]));
  shown.hidden = false;
  shown.loading.hidden = true;
  host.fetchedPictures.set(shown, { fetching: shownFetch, objectUrl: shown.src });
  host.fetchedPictures.set(arriving, { fetching: arrivingFetch, objectUrl: "" });

  host.releasePictures();

  assert.equal(shownFetch.signal.aborted, true);
  assert.equal(arrivingFetch.signal.aborted, true);
  assert.equal(shown.src, undefined);
  assert.equal(shown.hidden, true, "it goes back to loading");
  assert.equal(shown.loading.hidden, false);
  assert.equal(host.fetchedPictures.size, 0);
  delete globalThis.IntersectionObserver;
});
