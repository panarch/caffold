import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./current-plan.ts");
const CurrentPlan = registry.element("caffold-task-current-plan");
const { ActionHints } = await import("#app/action-hints.ts");
const { KeyboardContexts } = await import("#app/keyboard-navigation.ts");
after(() => registry.restore());

test("passes through the status popover and document dialog keyboard contexts", () => {
  const popover = { id: "popover" };
  const modal = { id: "modal" };
  const owner = planHost({
    keyboard: { contexts: () => [popover] },
    documentDialog: { value: { keyboardNavigationContexts: () => [modal] } },
  });
  assert.deepEqual(owner.keyboardNavigationContexts(), [popover, modal]);
});

test("draws a ready plan's title and progress, and a problem's status", () => {
  const ready = html(planHost({ projection: readyProjection() }));
  assert.match(ready, /<section class="task-current-plan-strip" aria-label="Current plan" data-presentation="ready" data-complete="false" \?hidden="false">/);
  assert.match(ready, /aria-label="Open plan: Keyboard scrolling" \?hidden="false"/);
  assert.match(ready, /title="Keyboard scrolling">Keyboard scrolling<\/strong>/);
  assert.match(ready, /aria-label="Open checklist: 4 of 9 complete"/);
  assert.match(ready, /data-current-plan-progress>4 \/ 9<\/span>/);
  assert.match(ready, /data-current-plan-action="status" popovertarget="[^"]+" aria-label="" title="" \?hidden="true"/);

  const problem = html(planHost({
    projection: {
      status: "problem",
      plan: null,
      problems: [{ document: "checklist", code: "missing", message: "Missing" }],
    },
    readError: new Error("Offline"),
  }));
  assert.match(problem, /data-presentation="problem" data-complete="" \?hidden="false"/);
  assert.match(problem, /aria-label="Plan status: CHECKLIST.md missing" title="CHECKLIST.md missing" \?hidden="false"/);
  assert.match(problem, /<div><dt>CHECKLIST.md missing<\/dt><dd>Missing<\/dd><\/div><div><dt>Couldn't load plan<\/dt><dd>Offline<\/dd><\/div>/);
  assert.match(problem, /data-current-plan-refresh \?hidden="false"/);

  const absent = html(planHost({ projection: { status: "absent", plan: null } }));
  assert.match(absent, /class="task-current-plan-strip"[^>]*\?hidden="true"/);
});

// A Current Plan with the given state, which draws through its own tools.
function planHost(properties) {
  const host = Object.create(CurrentPlan.prototype, {
    ...Object.getOwnPropertyDescriptors({
      context: { threadId: "thread-a", cwd: "task", rootPath: "task" },
      contextGeneration: 1,
      hidden: false,
      isConnected: true,
      node: "settled",
      projection: null,
      readError: null,
      watchError: null,
      statusPopoverId: "task-current-plan-status-test",
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  host.hints ??= new ActionHints(host);
  host.keyboard ??= new KeyboardContexts(host);
  return host;
}

function html(plan) {
  return templateHtml(plan.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}

function readyProjection() {
  return {
    status: "ready",
    plan: {
      title: "Keyboard scrolling",
      completed: 4,
      total: 9,
      planDocument: { path: "task/PLAN.md" },
      checklistDocument: { path: "task/CHECKLIST.md" },
    },
  };
}
