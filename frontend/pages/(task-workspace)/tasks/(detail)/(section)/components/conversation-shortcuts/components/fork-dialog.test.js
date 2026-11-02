import assert from "node:assert/strict";
import test, { after } from "node:test";
import { elementStandIn, installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";
const registry = installCustomElementUnitRegistry();
await import("./fork-dialog.js");
const dialog = registry.element("caffold-conversation-fork-dialog").prototype;
after(() => registry.restore());

test("provider changes invalidate a pending preview even if its answer ignores cancellation", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = forkOwner();
    const pending = owner.previewThread();
    assert.equal(owner.node, "previewing");
    owner.providerChanged({currentTarget: {value: "claude"}});
    assert.equal(owner.node, "editing");
    requests[0].answer(preview("codex"));
    await pending;
    assert.equal(owner.preview, null);
    const current = owner.previewThread();
    assert.equal(requests[1].body.provider, "claude");
    requests[1].answer(preview("claude"));
    await current;
    assert.equal(owner.node, "ready");
    assert.equal(owner.preview.provider, "claude");
  } finally { restore(); }
});

test("a failed handoff retries the same child and cannot issue another fork", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = forkOwner();
    owner.node = "ready"; owner.preview = preview("grok"); owner.provider = "grok";
    const created = { detail: {threadId: "child"}, activeTopPlacement: {section: {id: "section-a"}} };
    let handoffs = 0;
    owner.dispatchEvent = (event) => { event.detail.adopted = ++handoffs === 2; };
    const pending = owner.forkTask();
    assert.equal(owner.node, "forking");
    owner.providerChanged({currentTarget: {value: "claude"}});
    assert.equal(owner.provider, "grok");
    await owner.forkTask();
    assert.equal(requests.length, 1);
    requests[0].answer(created);
    await pending;
    assert.equal(owner.node, "ready");
    assert.equal(owner.created, created);
    await owner.forkTask();
    assert.equal(requests.length, 1);
    assert.equal(handoffs, 2);
    assert.equal(owner.node, "closed");
  } finally { restore(); }
});

test("deactivation discards a late creation response without deleting the server's child", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = forkOwner(); owner.node = "ready"; owner.preview = preview("codex");
    let handoffs = 0; owner.dispatchEvent = () => { handoffs++; };
    const pending = owner.forkTask();
    owner.deactivate();
    requests[0].answer({detail: {threadId:"child"}, activeTopPlacement:{section:{id:"section-a"}}});
    await pending;
    assert.equal(owner.node, "closed");
    assert.equal(handoffs, 0);
    assert.equal(owner.created, null);
    assert.equal(requests.length, 1);
  } finally { restore(); }
});


test("a claimed child whose detail failed can be opened but cannot be forked again", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = forkOwner(); owner.node = "ready"; owner.preview = preview("codex");
    const pending = owner.forkTask();
    requests[0].answer({error:{code:"task_fork_created",message:"Details unavailable",createdTaskId:"saved-child"}},409);
    await pending;
    assert.equal(owner.createdTaskId,"saved-child");
    assert.equal(owner.error.createdTaskId,"saved-child");
    owner.providerChanged({currentTarget:{value:"claude"}});
    owner.threadIdChanged({currentTarget:{value:"another"}});
    await owner.previewThread(); await owner.forkTask();
    assert.equal(owner.provider,"codex");
    assert.equal(owner.threadIdText,"source");
    assert.equal(requests.length,1);
  } finally { restore(); }
});

function forkOwner() {
  return elementStandIn(dialog, {
    node: "editing", provider: "codex", context: {sectionId:"section-a",sectionPath:"/repo"},
    threadIdText:"source", preview:null, created:null, createdTaskId:"", error:null,
    previewRequestId:0, forkRequestId:0, previewController:null,
    modal:{value:{open:true,close(){this.open=false;}}},
    threadIdInput:{value:{focus(){}}}, opener:null, restoreFocus:false,
    dispatchEvent(){},
  });
}
function preview(provider) {
  return {provider,sourceId:"source",displayName:"Source",status:{type:"idle"},recentHistory:[]};
}
function answerRequests(requests) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {...previousWindow,location:{origin:"https://caffold.test"}};
  globalThis.fetch = (url, options) => {
    const answer = Promise.withResolvers();
    requests.push({url:String(url), body:JSON.parse(options.body), answer:(body,status=200)=>answer.resolve({ok:status<400,status,json:async()=>body})});
    return answer.promise;
  };
  return () => { globalThis.fetch=previousFetch; globalThis.window=previousWindow; };
}
