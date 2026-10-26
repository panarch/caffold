import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./approval.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const { ScrollSurfaces } = await import("#app/scroll-scope.ts");
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

// A card's fields as its conversation sets them. Native DOM retention and
// activation are exercised by the owning approval browser spec.
function approvalHost(properties = {}) {
  const host = Object.create(Approval.prototype, {
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
  host.hints = new ActionHints(host, () => {});
  host.surfaces = new ScrollSurfaces(host, () => {});
  return host;
}

function cardHtml(request, properties = {}) {
  return templateHtml(approvalHost({ request, ...properties }).render());
}
