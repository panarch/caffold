import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./info.js");
const info = registry.element("caffold-notes-info").prototype;
after(() => registry.restore());

test("offers Note details from the header only while its popover is closed", () => {
  let open = false;
  const popover = { matches: () => open };
  const owner = {
    isConnected: true,
    hidden: false,
    note: { id: "note-a" },
    ensureRendered() {},
    infoButton: () => control("Note details"),
    infoPopover: () => popover,
  };

  const [target] = info.actionHintScope.call(owner, { scopeId: "notes" }).targets;
  assert.deepEqual(
    { id: target.id, actionId: target.actionId, label: target.label },
    {
      id: "notes:note-a:details:open",
      actionId: "navigation.note-details.open",
      label: "Note details",
    },
  );
  assert.equal(target.isActionable(), true);
  open = true;
  assert.equal(target.isActionable(), false, "an open popover has nothing to open");
  open = false;
  owner.note = { id: "note-b" };
  assert.equal(target.isActionable(), false, "a target belongs to the Note it opened for");

  owner.note = null;
  owner.hidden = true;
  assert.deepEqual(info.actionHintScope.call(owner).targets, []);
});

test("declares a session-bound popover context whose Action Hints are its Task links and copy actions", () => {
  const link = control("Write storage notes", { href: "/tasks/task-writer" });
  const popover = {
    matches: () => true,
    querySelector: () => ({
      actionHintDialog: () => ({}),
      scrollModeHud: () => ({}),
      scrollSurfaceSelector: () => ({}),
    }),
    querySelectorAll: () => [link],
  };
  const copyScopes = [];
  const owner = {
    isConnected: true,
    hidden: false,
    note: { id: "note-a" },
    ensureRendered() {},
    infoPopover: () => popover,
    copyPath: () => copyAction("copy-path"),
    copyMarkdown: () => copyAction("copy-markdown"),
  };
  function copyAction(name) {
    return {
      actionHintScope(options) {
        copyScopes.push({ name, ...options });
        return {
          blocked: false,
          targets: [{ id: `${options.scopeId}:${name}` }],
          mutationRoots: [],
          scrollRoots: [],
        };
      },
    };
  }

  const [context] = info.keyboardNavigationContexts.call(owner, { scopeId: "notes" });
  assert.equal(context.id, "notes:note-a:details");
  assert.equal(context.kind, "popover");
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.sessionBound, true);
  const [target, ...copyTargets] = context.actionHints.scope.targets;
  assert.deepEqual(
    { id: target.id, actionId: target.actionId, label: target.label },
    {
      id: "notes:note-a:details:task-link:0",
      actionId: "link.open",
      label: "Write storage notes",
    },
  );
  assert.deepEqual(copyTargets.map(({ id }) => id), [
    "notes:note-a:details:copy-path",
    "notes:note-a:details:copy-markdown",
  ]);
  assert.deepEqual(copyScopes.map(({ name, clipRoots }) => [name, clipRoots]), [
    ["copy-path", [popover]],
    ["copy-markdown", [popover]],
  ]);
  assert.equal(target.isActionable(), true);
  assert.equal(copyScopes[0].isCurrent(), true);
  owner.note = { id: "note-b" };
  assert.equal(target.isActionable(), false);
  assert.equal(copyScopes[0].isCurrent(), false, "a copy action belongs to the Note it was offered for");

  owner.hidden = true;
  assert.deepEqual(info.keyboardNavigationContexts.call(owner, { scopeId: "notes" }), []);
});

test("closes the popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const owner = { infoPopover: () => popover, deactivate: info.deactivate };

  info.handleDismiss.call(owner, { target: {} });
  assert.equal(hidden, 0);
  info.handleDismiss.call(owner, { target: popover });
  assert.equal(hidden, 1);
});

test("closes the popover for a different Note and keeps it open for the same Note", () => {
  const calls = [];
  const owner = {
    note: { id: "note-a" },
    hidden: false,
    ensureRendered() {},
    deactivate() {
      calls.push("close");
    },
    renderFields() {
      calls.push(`fields:${this.note.id}`);
    },
    copyPath: () => ({ setNote() {} }),
    copyMarkdown: () => ({ setNote() {} }),
  };

  info.setNote.call(owner, { id: "note-a" });
  info.setNote.call(owner, { id: "note-b" });
  info.setNote.call(owner, null);

  assert.deepEqual(calls, ["fields:note-a", "close", "fields:note-b", "close"]);
  assert.equal(owner.note, null);
  assert.equal(owner.hidden, true);
});

test("hands the Note it shows to each copy action", () => {
  const handed = [];
  const owner = {
    note: null,
    ensureRendered() {},
    deactivate() {},
    renderFields() {},
    copyPath: () => ({
      setNote(note) {
        handed.push(["path", note.id]);
      },
    }),
    copyMarkdown: () => ({
      setNote(note) {
        handed.push(["markdown", note.id]);
      },
    }),
  };

  info.setNote.call(owner, { id: "storage" });
  info.setNote.call(owner, null);
  assert.deepEqual(handed, [["path", "storage"], ["markdown", "storage"]]);
});

function control(label, attributes = {}) {
  return {
    disabled: false,
    isConnected: true,
    textContent: ` ${label} `,
    focus() {},
    click() {},
    getAttribute(name) {
      return name === "aria-label" ? label : attributes[name] ?? null;
    },
  };
}
