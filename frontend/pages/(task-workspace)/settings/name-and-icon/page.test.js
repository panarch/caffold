import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const nameAndIconPage = registry.element(
  "caffold-settings-name-and-icon-page",
).prototype;
after(() => registry.restore());

function pageWith({ draft, saved = "Caffold", accepted = true }) {
  const sent = [];
  const page = elementStandIn(nameAndIconPage, {
    draft,
    snapshot: {
      settings: { name: saved, icon: "default", icons: [] },
      ready: true,
      busy: false,
      retry: false,
      message: "",
    },
    lifecycle: {
      saveName: async (name) => {
        sent.push(name);
        return accepted;
      },
      deactivate() {},
    },
  });
  return { page, sent };
}

const submit = { preventDefault() {} };

test("Save sends the typed name without its outer spaces, then shows the saved one", async () => {
  const { page, sent } = pageWith({ draft: "  Caffold Linux " });

  await page.saveName(submit);

  assert.deepEqual(sent, ["Caffold Linux"]);
  assert.equal(page.draft, null);
});

test("a name that is empty, unchanged, or untouched is not sent", async () => {
  for (const draft of [null, "", "   ", " Caffold "]) {
    const { page, sent } = pageWith({ draft });

    await page.saveName(submit);

    assert.deepEqual(sent, [], JSON.stringify(draft));
  }
});

test("a name the server refuses stays as it was typed", async () => {
  const { page, sent } = pageWith({ draft: "x".repeat(65), accepted: false });

  await page.saveName(submit);

  assert.equal(sent.length, 1);
  assert.equal(page.draft, "x".repeat(65));
});

test("leaving the page forgets a name that was not saved", () => {
  const { page } = pageWith({ draft: "Caffold Linux" });

  page.deactivate();

  assert.equal(page.draft, null);
});
