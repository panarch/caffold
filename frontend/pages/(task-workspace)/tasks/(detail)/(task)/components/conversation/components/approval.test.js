import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./approval.ts");
const Approval = registry.element("caffold-task-approval");
after(() => registry.restore());

test("tool details escape external text and preserve exact JSON argument values", () => {
  const html = cardHtml({
    approvalId: "mcp:42", title: "Read document", reason: "Allow this tool?",
    tool: {
      serverName: "docs<script>", appName: "Documents", description: "Reads <content>.",
      arguments: [
        { name: "document", label: "Document", value: { id: 42, include: false, tag: null } },
        { name: "text", label: "text", value: "<script>alert(1)</script>" },
        { name: "values", label: "Values", value: [1, true] },
      ],
    },
  });
  assert.match(html, /<h3>Read document<\/h3>/);
  assert.match(html, />Allow this tool\?<\/p>/);
  assert.match(html, /docs&lt;script&gt;/);
  assert.match(html, /Reads &lt;content&gt;/);
  assert.match(html, /&quot;include&quot;: false/);
  assert.match(html, /&quot;tag&quot;: null/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /tabindex="0"\s+aria-label="Document"/);
  assert.doesNotMatch(html, /<script>/);
});

test("a card names how sure the reviewer was, because only a short answer leaves one", () => {
  const html = cardHtml({
    approvalId: "reviewed", command: "rm -f ./scratch.txt",
    reviewed: { model: "jev-1.13.0", concern: 0.62, allows: false },
  });

  assert.match(html, /Reviewer answer/);
  assert.match(html, /62% sure this needs you/);
  assert.match(html, /jev-1\.13\.0/);
});

test("a card the reviewer never answered says nothing about a reviewer", () => {
  const html = cardHtml({
    approvalId: "unreviewed", command: "rm -f ./scratch.txt",
  });

  assert.doesNotMatch(html, /Reviewer answer/);
  assert.doesNotMatch(html, /Jev/);
});

test("command, network, permissions, and context share the normalized card", () => {
  const html = cardHtml({
    approvalId: "permission", command: "cat <secret>", cwd: "src/test", environment: "Local",
    networkEndpoint: "example.com:443", grantRoot: "/work/tree",
    permissions: [{ label: "Read", value: "/work/tree", verbatim: true }],
  });
  for (const pattern of [/cat &lt;secret&gt;/, /example.com:443/, /Requested permissions/, /Grant root/, /Working directory/, /Environment/]) {
    assert.match(html, pattern);
  }
  assert.match(html, /aria-label="Approval command"/);
  // A path breaks after each separator.
  assert.match(html, /<code>\/<wbr>work\/<wbr>tree<\/code>/);
});

test("refresh, errors, and transport changes retain details; new identity clears local error", () => {
  const request = { approvalId: "same", command: "cargo test", decisions: ["allow", "deny"] };
  const owner = approvalHost({ request });
  assert.match(templateHtml(owner.render()), /role="alert"\s+\?hidden="true"\s*><\/p>/);
  owner.setError(new Error("Try again"));
  assert.match(
    templateHtml(owner.render()),
    /role="alert"\s+\?hidden="false"\s*>Try again<\/p>/,
  );
  owner.request = structuredClone(request);
  owner.willUpdate(new Map([["request", request]]));
  owner.disabled = true;
  owner.willUpdate(new Map([["disabled", false]]));
  assert.equal(owner.errorMessage, "Try again");
  owner.threadId = "b";
  owner.willUpdate(new Map([["threadId", "a"]]));
  assert.equal(owner.errorMessage, "");
  owner.setError(new Error("Different request"));
  const previous = owner.request;
  owner.request = { approvalId: "new" };
  owner.willUpdate(new Map([["request", previous]]));
  assert.equal(owner.errorMessage, "");
});

test("offered decisions expose native activation with card-owned invalidation", () => {
  const choices = ["allow", "allowForSession", "allowAlways", "deny", "cancel"];
  let controls = choices.map((decision) => ({
    dataset: { decision }, textContent: decision, disabled: false,
    focus() {}, click() { this.clicks = (this.clicks ?? 0) + 1; },
  }));
  const owner = approvalHost({
    request: { approvalId: "same", decisions: choices },
    get actions() { return controls; },
  });
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
  let outputs = ["Approval command", "Document"].map((label) => ({
    getClientRects: () => [{}], getAttribute: () => label,
  }));
  const owner = approvalHost({
    querySelectorAll: () => outputs,
    contains: (node) => outputs.includes(node),
  });
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

// A card's fields as its conversation sets them. Native DOM retention and
// activation are exercised by the owning approval browser spec.
function approvalHost(properties = {}) {
  return Object.create(Approval.prototype, {
    ...Object.getOwnPropertyDescriptors({
      threadId: "a",
      request: { approvalId: "same" },
      disabled: false,
      active: true,
      errorMessage: "",
      isConnected: true,
      hidden: false,
      getClientRects: () => [{}],
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

function cardHtml(request, properties = {}) {
  return templateHtml(approvalHost({ request, ...properties }).render());
}
