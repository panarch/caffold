import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./approval.js");
const Approval = registry.element("caffold-task-approval");
after(() => registry.restore());

test("tool details escape external text and preserve exact JSON argument values", () => {
  const { owner, content, title, reason } = presentationOwner();
  owner.setSnapshot({ threadId: "a", request: {
    approvalId: "mcp:42", title: "Read document", reason: "Allow this tool?",
    tool: {
      serverName: "docs<script>", appName: "Documents", description: "Reads <content>.",
      arguments: [
        { name: "document", label: "Document", value: { id: 42, include: false, tag: null } },
        { name: "text", label: "text", value: "<script>alert(1)</script>" },
        { name: "values", label: "Values", value: [1, true] },
      ],
    },
  } });
  assert.equal(title.textContent, "Read document");
  assert.equal(reason.textContent, "Allow this tool?");
  assert.match(content.innerHTML, /docs&lt;script&gt;/);
  assert.match(content.innerHTML, /Reads &lt;content&gt;/);
  assert.match(content.innerHTML, /&quot;include&quot;: false/);
  assert.match(content.innerHTML, /&quot;tag&quot;: null/);
  assert.match(content.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(content.innerHTML, /tabindex="0" aria-label="Document"/);
  assert.doesNotMatch(content.innerHTML, /<script>/);
});

test("command, network, permissions, and context share the normalized card", () => {
  const { owner, content } = presentationOwner();
  owner.setSnapshot({ threadId: "a", request: {
    approvalId: "permission", command: "cat <secret>", cwd: "src/test", environment: "Local",
    networkEndpoint: "example.com:443", grantRoot: "/work/tree",
    permissions: [{ label: "Read", value: "/work/tree", verbatim: true }],
  } });
  for (const pattern of [/cat &lt;secret&gt;/, /example.com:443/, /Requested permissions/, /Grant root/, /Working directory/, /Environment/]) {
    assert.match(content.innerHTML, pattern);
  }
  assert.match(content.innerHTML, /aria-label="Approval command"/);
});

test("refresh, errors, and transport changes retain details; new identity clears local error", () => {
  const { owner, content, error } = presentationOwner();
  const snapshot = { threadId: "a", request: {
    approvalId: "same", command: "cargo test", decisions: ["allow", "deny"],
  } };
  owner.setSnapshot(snapshot);
  const writes = content.writes;
  owner.setError(new Error("Try again"));
  assert.equal(error.textContent, "Try again");
  assert.equal(error.hidden, false);
  owner.setSnapshot(structuredClone(snapshot));
  owner.setSnapshot({ ...snapshot, disabled: true });
  assert.equal(content.writes, writes);
  assert.equal(owner.errorMessage, "Try again");
  owner.setSnapshot({ ...snapshot, threadId: "b" });
  assert.equal(error.hidden, true);
  assert.equal(owner.errorMessage, "");
  owner.setError("Different request");
  owner.setSnapshot({ threadId: "b", request: { approvalId: "new" } });
  assert.equal(owner.errorMessage, "");
});

test("offered decisions expose native activation with card-owned invalidation", () => {
  const owner = scopeOwner();
  const choices = ["allow", "allowForSession", "allowAlways", "deny", "cancel"];
  let controls = choices.map((decision) => ({
    dataset: { decision }, textContent: decision, disabled: false,
    focus() {}, click() { this.clicks = (this.clicks ?? 0) + 1; },
  }));
  owner.request.decisions = choices;
  owner.actions = () => controls;
  let current = true;
  const scope = owner.actionHintScope({ scopeId: "approval:a", isCurrent: () => current });
  assert.deepEqual(scope.targets.map((target) => target.id), choices.map((choice) => `approval:a:${choice}`));
  assert.ok(scope.targets.every((target) => target.invalidationOwner === owner));
  const target = scope.targets[1];
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(controls[1].clicks, 1);
  for (const field of ["disabled", "hidden"]) {
    owner[field] = true;
    assert.equal(target.isActionable(), false);
    assert.deepEqual(owner.actionHintScope({ scopeId: "approval:a" }).targets, []);
    owner[field] = false;
  }
  owner.active = false;
  assert.equal(target.isActionable(), false);
  owner.active = true;
  owner.isConnected = false;
  assert.equal(target.isActionable(), false);
  owner.isConnected = true;
  current = false;
  assert.equal(target.isActionable(), false);
  current = true;
  owner.threadId = "other";
  assert.equal(target.isActionable(), false);
  owner.threadId = "a";
  owner.request.decisions = ["allow"];
  assert.equal(target.isActionable(), false);
  owner.request.decisions = choices;
  controls = [];
  assert.equal(target.isActionable(), false);
});

test("command and argument scroll surfaces expire when their DOM or Task is replaced", () => {
  const owner = scopeOwner();
  let outputs = ["Approval command", "Document"].map((label) => ({
    getClientRects: () => [{}], getAttribute: () => label,
  }));
  owner.querySelectorAll = () => outputs;
  owner.contains = (node) => outputs.includes(node);
  let current = true;
  const scope = owner.scrollSurfaceScope({ scopeId: "approval:a", isCurrent: () => current });
  assert.deepEqual(scope.surfaces.map(({ label, axes }) => ({ label, axes })), [
    { label: "Approval command", axes: ["horizontal"] },
    { label: "Document", axes: ["horizontal"] },
  ]);
  const surface = scope.surfaces[1];
  assert.equal(surface.isEligible(), true);
  owner.active = false;
  assert.equal(surface.isEligible(), false);
  owner.active = true;
  current = false;
  assert.equal(surface.isEligible(), false);
  current = true;
  owner.threadId = "b";
  assert.equal(surface.isEligible(), false);
  owner.threadId = "a";
  outputs = [];
  assert.equal(surface.isEligible(), false);
});

function scopeOwner() {
  const owner = new Approval();
  owner.ensureState();
  Object.assign(owner, {
    threadId: "a", request: { approvalId: "same" },
    isConnected: true, hidden: false, getClientRects: () => [{}],
  });
  return owner;
}

// These tests observe presentation writes. Native DOM retention and activation
// are exercised by the owning approval browser spec.
function presentationOwner() {
  const owner = scopeOwner();
  const title = { textContent: "" };
  const reason = { textContent: "", hidden: true };
  const error = { textContent: "", hidden: true };
  const content = {
    writes: 0,
    set innerHTML(value) { this.html = value; this.writes += 1; },
    get innerHTML() { return this.html; },
  };
  const card = {
    dataset: {},
    querySelector(selector) {
      if (selector.endsWith("h3")) return title;
      if (selector.endsWith(".task-approval-reason")) return reason;
      if (selector.endsWith(".task-approval-content")) return content;
      throw new Error(`Unexpected card selector: ${selector}`);
    },
  };
  owner.querySelector = (selector) => selector === ":scope > article" ? card : error;
  owner.updateActions = () => {};
  return { owner, content, title, reason, error };
}
