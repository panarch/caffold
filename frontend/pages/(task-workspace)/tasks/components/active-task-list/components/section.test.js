import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./section.ts");
const Section = registry.element("caffold-active-task-section");
after(() => registry.restore());

const taskOperations = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

function snapshot(overrides = {}) {
  return {
    section: {
      id: "section-a",
      name: "/repo/alpha",
      label: "alpha",
      repository: true,
      recovery: false,
      tasks: [{ threadId: "thread-a" }, { threadId: "thread-b" }],
    },
    selectedSectionId: "",
    selectedThreadId: "",
    taskOperations,
    reorderMode: "none",
    pending: false,
    ...overrides,
  };
}

test("offers the Section's header before its Task rows", () => {
  const clipRoot = {};
  let clicks = 0;
  const control = {
    disabled: false,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const taskTarget = { id: "task:thread-a" };
  const taskReorderTarget = { id: "task:thread-a:reorder" };
  const row = {
    actionHintTarget: () => taskTarget,
    reorderActionHintTarget: () => taskReorderTarget,
  };
  const sectionHandle = {
    disabled: false,
    getAttribute: () => "Reorder alpha",
    focus() {},
  };
  let currentHandle = sectionHandle;
  const section = sectionHost({
    snapshot: snapshot(),
    querySelector: (selector) =>
      selector.includes("section-reorder-handle") ? currentHandle : control,
    querySelectorAll: () => [row],
  });

  const targets = section.actionHintTargets({ clipRoots: [clipRoot] });
  assert.equal(targets.length, 2);
  assert.deepEqual(
    {
      id: targets[0].id,
      actionId: targets[0].actionId,
      label: targets[0].label,
      controlKind: targets[0].controlKind,
    },
    {
      id: "section:section-a",
      actionId: "navigation.section.open",
      label: "Open section: alpha",
      controlKind: "button",
    },
  );
  assert.deepEqual(targets[0].clipRoots, [clipRoot]);
  assert.equal(targets[0].isActionable(), true);
  targets[0].activate();
  assert.equal(clicks, 1);
  assert.equal(targets[1], taskTarget);

  section.snapshot = snapshot({ reorderMode: "tasks" });
  assert.deepEqual(section.actionHintTargets(), [taskReorderTarget]);

  section.snapshot = snapshot({ reorderMode: "sections" });
  assert.equal(targets[0].isActionable(), false);
  const reorderTargets = section.actionHintTargets();
  assert.equal(reorderTargets.length, 1);
  assert.deepEqual(
    {
      id: reorderTargets[0].id,
      actionId: reorderTargets[0].actionId,
      controlKind: reorderTargets[0].controlKind,
      label: reorderTargets[0].label,
    },
    {
      id: "section:section-a:reorder",
      actionId: "task.reorder.handle.focus",
      controlKind: "reorder-handle",
      label: "Reorder alpha",
    },
  );
  assert.equal(reorderTargets[0].isActionable(), true);
  currentHandle = { ...sectionHandle };
  assert.equal(reorderTargets[0].isActionable(), false);
  section.snapshot = snapshot({ reorderMode: "sections", pending: true });
  assert.deepEqual(section.actionHintTargets(), []);
  section.snapshot = snapshot({
    reorderMode: "sections",
    section: { ...snapshot().section, recovery: true },
  });
  assert.deepEqual(section.actionHintTargets(), []);
});

test("draws a header that opens the Section, counts its Tasks, and holds its handle", () => {
  const open = html(sectionHost({
    snapshot: snapshot({ selectedSectionId: "section-a" }),
  }));
  assert.match(open, /^<div class="task-repository-header"><button type="button" class="task-repository-select" title="\/repo\/alpha" data-section-id="section-a" aria-current="page" data-active-task-section-action="open-section"/);
  assert.match(open, /<span class="task-repository-label">alpha<\/span><\/button><span class="task-repository-count">2<\/span><button type="button" class="section-reorder-handle" data-section-id="section-a" aria-label="Reorder alpha"/);
  assert.match(open, /<ol class="task-list" @caffold:active-task-row-intent=""><\/ol>$/);

  const reordering = html(sectionHost({
    snapshot: snapshot({ reorderMode: "sections" }),
  }));
  assert.match(reordering, /<div class="task-repository-select" title="\/repo\/alpha" data-section-id="section-a" aria-current="false">/);

  const recovery = html(sectionHost({
    snapshot: snapshot({
      section: { ...snapshot().section, label: "Recovery", recovery: true },
    }),
  }));
  assert.match(recovery, /<div class="task-repository-select" title="\/repo\/alpha" data-section-id="" aria-current="">/);
  assert.doesNotMatch(recovery, /section-reorder-handle/);
});

function sectionHost(properties) {
  return Object.create(Section.prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...properties,
  }));
}

function html(section) {
  return templateHtml(section.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
