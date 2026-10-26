import assert from "node:assert/strict";
import test, { after } from "node:test";

const previousNode = globalThis.Node;
globalThis.Node = { DOCUMENT_POSITION_PRECEDING: 2 };
const { ElementDeclarations } = await import("./element-declarations.ts");

after(() => restoreGlobal("Node", previousNode));

test("lists declarations in document order, whatever order they arrived in", () => {
  const tree = documentTree();
  const owner = tree.element(null);
  const first = tree.element(owner);
  const second = tree.element(owner);
  const declarations = new ElementDeclarations(owner);
  declarations.add({}, { element: second, value: "second" });
  declarations.add({}, { element: first, value: "first" });

  assert.deepEqual(
    declarations.list().map((entry) => entry.value),
    ["first", "second"],
  );
});

test("puts what is declared inside a modal or popover with the nearest one", () => {
  const tree = documentTree();
  const outerRoot = tree.element(null);
  const owner = tree.element(outerRoot);
  const trigger = tree.element(owner);
  const popover = tree.element(owner);
  const item = tree.element(popover);
  const roots = new ElementDeclarations(owner, { contextRoots: true });
  roots.add({}, { element: outerRoot, value: null });
  roots.add({}, { element: popover, value: null });
  const declarations = new ElementDeclarations(owner);
  declarations.add({}, { element: trigger, value: "trigger" });
  declarations.add({}, { element: item, value: "item" });

  const values = (entries) => entries.map((entry) => entry.value);
  assert.deepEqual(values(declarations.list()), ["trigger"]);
  assert.deepEqual(values(declarations.list(outerRoot)), ["trigger"]);
  assert.deepEqual(values(declarations.list(popover)), ["item"]);
  assert.deepEqual(values(declarations.list(null)), []);
});

test("forgets a declaration once its element is no longer drawn", () => {
  const tree = documentTree();
  const owner = tree.element(null);
  const declarations = new ElementDeclarations(owner);
  const key = {};
  declarations.add(key, { element: tree.element(owner), value: "kept" });
  declarations.add(key, { element: tree.element(owner), value: "redrawn" });

  assert.deepEqual(
    declarations.list().map((entry) => entry.value),
    ["redrawn"],
  );
  declarations.remove(key);
  assert.deepEqual(declarations.list(), []);
});

// Elements that know their parent and their place in document order.
function documentTree() {
  let order = 0;
  return {
    element(parentElement) {
      const index = order++;
      return {
        parentElement,
        index,
        compareDocumentPosition(other) {
          return other.index < index ? 2 : 4;
        },
      };
    },
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
