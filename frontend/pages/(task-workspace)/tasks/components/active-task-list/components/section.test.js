import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./section.js");
const { ActionHints } = await import("#app/action-hints.js");
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

test("merges its header's actions with its rows' unless Sections reorder", () => {
  const pulls = [];
  const scope = (name) => (pull) => {
    pulls.push([name, pull]);
    return { targets: [{ id: name }] };
  };
  const section = sectionHost({
    snapshot: snapshot(),
    hints: { scope: scope("header") },
    rowComponents: () => [
      { actionHintScope: scope("thread-a") },
      { actionHintScope: scope("thread-b") },
    ],
  });
  const pull = { clipRoots: [{}] };

  assert.deepEqual(
    section.actionHintScope(pull).targets.map(({ id }) => id),
    ["header", "thread-a", "thread-b"],
  );
  assert.deepEqual(pulls, [
    ["header", pull],
    ["thread-a", pull],
    ["thread-b", pull],
  ]);

  section.snapshot = snapshot({ reorderMode: "sections" });
  assert.deepEqual(
    section.actionHintScope(pull).targets.map(({ id }) => id),
    ["header"],
  );
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
  const section = Object.create(
    Section.prototype,
    Object.getOwnPropertyDescriptors({ isConnected: true, ...properties }),
  );
  section.hints ??= new ActionHints(section);
  return section;
}

function html(section) {
  return templateHtml(section.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
