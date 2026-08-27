# Agent Runtimes

This document owns Caffold's implemented multi-agent boundary: why supported
agents keep separate native integrations, what the Task application shares,
and which state and lifecycle remain specific to Codex or Claude Code.

It is a current architecture description, not a plugin API or a compatibility
promise for agents Caffold does not drive.

## Design premise

Caffold treats a coding agent as a model and its harness together. The harness
owns tools, context assembly, permission semantics, session behavior, and the
way new capabilities are introduced. Replacing it with a Caffold-owned generic
loop would change the agent even if the model stayed the same.

The integration therefore follows four rules:

1. **Use the agent's native programmatic surface.** Codex is reached through
   app-server. Claude is reached through the Claude Code CLI's stream-json and
   control protocols.
2. **Do not copy state the agent already owns.** Codex threads remain in
   app-server; Claude conversations remain in Claude's transcript files.
3. **Share only verified product semantics.** Conversation, turns, activity,
   approvals, and Task operations have a Caffold vocabulary. Wire methods,
   payloads, models, and permission modes remain agent-specific.
4. **Make differences explicit.** The driver set is a closed Rust enum. A
   capability that one agent has and another lacks requires an explicit match
   arm at the use site instead of falling through a runtime default.

This gives both supported harnesses a first-class path without defining the
product by their lowest common subset.

## Boundary

```text
Browser / PWA
      |
Tasks application
      |
Caffold conversation, event, approval, and driver vocabulary
      |                                      |
Codex native driver                    Claude native driver
      |                                      |
Codex app-server                    Claude CLI protocol
      |                                      |
persistent Codex daemon          Caffold runner -> claude process
```

`caffold/src/agent/` is the boundary. Its top-level conversation and approval
types are the smallest vocabulary the product actually renders. Each driver
translates its agent into that vocabulary at one edge; the Tasks application
and browser do not parse provider wire messages.

`caffold/src/agent/driver.rs` contains the closed `Driver` choice and the
operations Caffold has verified for both agents:

- validate and apply model, effort, speed, and permission choices;
- create, open, watch, and page a conversation;
- start, steer, and interrupt a turn;
- archive, restore, and delete a conversation; and
- report whether an archived conversation still exists.

Approval translation, readiness, diagnostics, and provider-specific controls
remain in each driver where their meanings differ. Shared HTTP routes ask the
recorded driver and carry back options under the agent's own identifiers.

## A Task belongs to one agent

The model list labels every model with the provider that offered it. Choosing a
model for a New Task therefore chooses Codex or Claude without guessing from
the model name. The managed Task row persists that provider before the Task
appears in the navigator.

An existing Task cannot change providers. Its conversation identifier,
history, cwd ownership, permission semantics, and process lifecycle all belong
to the agent that created it. Switching a Task in place would produce a new
conversation while presenting it as continuity, so Caffold refuses that model
instead of emulating it.

Codex and Claude models may expose different effort levels, fast modes, and
permission modes. The composer shows what the selected agent offers. A choice
travels back under the agent's own name, and the driver verifies it before a
conversation or turn is created. Caffold never invents a common permission
profile and does not silently substitute one agent's default for another's.

## Archive and permanent deletion

The common Task action has provider-specific conversation work behind it.
Archiving asks Codex to archive its thread. Claude has no corresponding archive
state, so Caffold closes any live session and keeps the archived Task row while
Claude's transcript remains available for a later resume. Restoring reverses
the Codex archive; a Claude restore only makes the retained Task active again.

Permanent deletion is available only after archive and asks the recorded
driver to forget the conversation before Caffold deletes its own row. Codex
uses app-server thread deletion. Claude removes the exact transcript file and
the same-session directory beside it, including subagent conversations and
spilled tool output, after deriving and validating the path from the Task's
conversation ID and cwd. Neither path deletes a Git branch.

## Runtime comparison

| Boundary | Codex | Claude Code |
| --- | --- | --- |
| Native surface | Experimental v2 app-server protocol | CLI stream-json plus bidirectional control protocol |
| Long-lived process | User-global app-server daemon | One Caffold runner per data directory, with one `claude` child per live session |
| Caffold transport | Disposable proxy child and JSON-RPC/WebSocket connection | Unix-socket runner connection carrying raw newline-delimited frames to child stdio |
| Conversation history | App-server thread and paged turns | Claude-owned JSONL transcript read tolerantly by Caffold |
| Active-turn survival across backend replacement | The daemon owns the turn; a new proxy reconnects | The runner owns the child; a new backend reattaches and asks the session for current state |
| Working directory | Reported and owned by the Codex thread | Persisted with the Caffold Task and supplied whenever the Claude session starts or resumes |
| Caffold-served Task tools | Caffold-owned HTTP MCP config on thread start and resume; calls from dynamic tools persisted by pre-MCP threads remain supported | In-process MCP server declared whenever the session is initialized |
| Readiness | Typed, blocking installation and app-server readiness | Diagnostic status; an attempted operation reports its own failure |
| Idle release | A thread subscription may be dropped when no viewer or runtime lease remains | The session stays attached; detaching and immediately reattaching is not a free operation |

The table describes ownership, not a feature score. Both drivers support the
implemented Task loop, but they reach it through different guarantees.

## Codex lifecycle

The official standalone Codex CLI supplies a persistent app-server daemon.
Caffold owns a disposable proxy connection, not the daemon or its active
turns. Replacing the backend replaces that proxy and resumes the managed
threads that still need observation.

App-server is the source of truth for the Codex conversation, thread and turn
status, approvals, history, cwd, and runtime events. Caffold keeps only its own
Task membership, navigator projection, composer settings, review state, and
managed-worktree recovery data.

Codex readiness is evaluated before agent operations because Caffold can
validate the supported standalone installation, daemon commands, running
version, authentication, and protocol initialization without creating a Task.
The resulting state gates only Codex surfaces. See
[Codex App Server](codex-app-server.md) for the complete transport,
subscription, readiness, and reconciliation contract.

## Claude lifecycle

Claude Code's programmatic surface is a CLI child over stdio rather than a
durable app-server daemon. Caffold supplies only the missing process-lifetime
layer: the bundled `caffold-claude-runner` supervises child processes and
relays their frames unchanged over a Unix socket.

The runner deliberately knows no Claude or Caffold product concepts. It does
not parse arguments or frames, answer approvals, choose models, or keep
history. Those responsibilities stay in the Claude driver and the Claude CLI.
Its narrow contract lets the runner outlive a backend replacement without
having to evolve with every Claude message type.

One backend subscription carries events for every attached Claude session.
When the backend reconnects, it asks the runner which sessions remain and asks
each Claude process to initialize again. Claude reports whether a prompt is
active and redelivers pending permission requests with their original
identities. Caffold reads the agent-owned transcript for the conversation and
lays the live session state over it; it never persists a normalized transcript
of its own.

Claude session activity and turn lifecycle are independent provider facts.
Each Claude child reports its moves between idle, working, and requiring action;
the same state is returned when a surviving child is initialized again. Caffold
projects that observation onto the Task's activity without creating, identifying,
or ending a turn. Replayed prompts and transcript or result evidence remain the
only writers of Claude's turn ledger. Codex status and turn lifecycle retain
their app-server-owned coupled path through the same shared Task state.
An initialize answer is only a current snapshot: until this backend sees a live
activity frame, it retains the turn-based fallback for a child that may have
survived from before activity events were enabled.

The runner stops after ten minutes without a backend subscriber, ending its
children and removing its socket. An explicit Claude runtime restart does the
same immediately and then starts a fresh runner. Ended conversations remain
resumable from Claude's transcript when their Tasks are opened.

A newly created Claude Task legitimately has no transcript until its first
ordinary prompt materializes provider history. A backend replacement reattaches
to the runner's exact live session when that session survived. If both the live
session and transcript are absent, the adapter does not infer that the Task is
fresh or recreate the conversation from its empty content; it reports the
provider conversation unavailable. The durable Task remains an honest
zero-turn record, but a runner restart before its first prompt is therefore an
accepted no-transcript recovery limit rather than a hidden state or inferred
replay rule.

New authenticating Claude starts pass through one backend-owned gate. Direct
measurement showed that two young CLI processes can refresh the same account
credential concurrently and cause the service to revoke the login. Caffold
therefore serializes and spaces new session and one-off authenticated starts.
Reattaching to an already running child is not counted as another start. The
runner remains transport-only and does not implement this account policy.

The runner's lower-level process, relay, stale-child, and test contract is
documented in [caffold-claude-runner](../../runners/claude/README.md).

## Conversation and event ownership

Caffold's normalized conversation is a projection, not a second transcript.
It contains only what the interface and Task lifecycle consume:

- user and agent messages;
- reasoning and tool activity;
- commands, output, and changed paths;
- turn and conversation status;
- token usage where the agent reports it; and
- approvals under a Caffold identity paired privately with the provider
  request that must be answered.

### Provider evidence

The Codex driver translates app-server threads, items, notifications, and
server requests. The Claude driver translates stream frames and transcript
content blocks. Unknown optional events may be ignored or presented as generic
tool activity; missing load-bearing fields fail explicitly. The provider's raw
protocol does not escape into Task or frontend state.

Provider history and live observation do not own the same facts. Codex
app-server turn history and Claude transcript history own causal order for a
turn Caffold did not watch from its boundary. A live `turn_started` is evidence
that Caffold watched the turn from its boundary only while that observation
remains continuous; that one live journal then owns the turn's item set and
direct observation times. A provider connection loss or dropped-report gap
withdraws the completeness claim without deleting reports already observed,
so history becomes the baseline again. Caffold does not mix a second history
projection into a continuous journal, because some providers expose
history-local item ids that cannot be equated with their live ids.

Within either source, repeated reports under one exact item identity update one
item. Submission observation and provider identity remain separate: the
browser may place an optimistic prompt when it submits the request, but only
the exact identity returned by the adapter hands that prompt off to the
projection. The handoff keeps its provisional browser position until a
complete Detail supplies backend placement, so identity delay cannot move the
prompt behind an answer produced in the meantime. For a recovered turn, live
reports may enrich history only under an exact identity. Content, proximity,
and arrival order are never substitutes for that identity.

This contract includes a Task's first message. Task creation commits only the
empty conversation and local membership; it carries title-source metadata but
does not create a submitted item. The later ordinary prompt boundary supplies
the adapter-owned identity. Task creation metadata does not supply that
message's observation or turn time.

An item-level provider timestamp, such as a Claude transcript row timestamp,
crosses as `observedMs` without taking ownership of causal order. When history
supplies item order but no item time, `position.anchorMs` places the group and
`position.index` preserves provider order within it while `observedMs` is
`null`; neither position field is an individual event time, so the interface
must not print the turn anchor as every item's timestamp.

### Backend reconciliation

The Task backend retains live observations with their explicit operation role:
provider lifecycle, accepted submission, or Caffold-owned projection. It
advances repeated live reports within that role, then reconciles provider
history and retained observations when it assembles Detail. Provider history
owns the baseline after recovery or an observation gap; a live report may
replace a conflicting history field only under exact identity and evidence
that the report followed the read it advances. Backend-private session
causality and cache-observation recency do not cross this boundary as item
freshness or display fields.

### Projection publication

Every accepted Task-event delta receives a process-local, per-Task
`eventRevision` when it enters the conversation projection. A Detail snapshot
captures the retained observations and a watermark that covers them in the
same backend owner. This publication sequence is independent of the Task
session `revision` used to arbitrate canonical reads and Task metadata. It
establishes only whether an independently delivered conversation snapshot or
delta is already covered; it is not item identity, provider causality,
conversation position, or time.

A current-page Detail snapshot with provider history available owns the
membership of its conversation projection. A snapshot marked `historyLoading`
owns the exact identities it contains but cannot prove that an absent,
previously readable item was deleted. Older cursor pages remain a separate
history layer and do not become another current live ledger.

The agent still owns the meaning of a permission. Caffold owns the human answer
vocabulary—allow, allow always, deny, and deny and stop—and each driver offers
only decisions its agent can carry out. See
[Security and Approvals](security-and-approvals.md) for the exact mappings.

## Caffold-served tools and worktrees

Caffold exposes Task naming and managed-worktree isolation through the native
extension point each agent already understands:

- Codex receives Caffold's authenticated HTTP MCP server when a thread starts
  or resumes. New threads do not receive Caffold dynamic tools. Caffold still
  answers calls from definitions already persisted on pre-MCP threads. The MCP
  catalog refresh boundary is a new app-server proxy connection followed by
  thread start or resume; active-thread hot reload is not part of the contract.
  Its single installation-local signing key is opened lazily and only for signed
  Codex MCP sessions. Neither route initialization nor a signing-key failure
  makes Codex a prerequisite for a Claude-only Caffold service.
- Claude receives an in-process MCP server on every initialization, including
  resumed and reattached sessions.

Both MCP catalogs use the Task-owned base names `rename_current_task` and
`isolate_current_task`; Claude's transport qualifies them as
`mcp__caffold__...`, while Codex presents the base names directly. Only the
pre-MCP Codex dynamic-tool compatibility path accepts the historical
`rename_current_thread` name.

The application handles both requests through the same Task and Git lifecycle.
Only delivery and cwd movement differ. Codex accepts a new cwd for the next
turn. A Claude process changes cwd only between turns, so Caffold completes the
Git preparation, ends the setup turn, then moves the session before another
turn can begin. The full safety and recovery contract belongs to
[Managed Worktree Lifecycle](worktree-lifecycle.md).

## Source of truth

| State | Owner |
| --- | --- |
| Codex conversation, cwd, turns, and runtime status | Codex app-server |
| Claude conversation history | Claude's transcript file |
| Live Claude process and pending control requests | Claude process, held and relayed by the Caffold runner |
| Task membership, provider, display name, Section placement, composer state, and managed-worktree recovery | Caffold Redb |
| Files, diffs, branches, and commits | Git checkout or worktree |
| Presentation, selection, and transient request state | Browser/PWA |

When an owning source is unavailable, Caffold reports that condition or uses a
strictly Caffold-owned fallback such as an archived Task row. It does not infer
provider state from the browser, a prior event, or a copied transcript.

## Extending agent support

Caffold currently compiles support for Codex and Claude. It does not discover
drivers, load provider code, or implement ACP at runtime. This closed set is an
intentional safety and review boundary: adding an agent requires source,
protocol fixtures, lifecycle and approval behavior, compatibility checks, UI
decisions, and tests in the same repository.

For a new capability or a future agent:

1. identify the durable Caffold product meaning, if one exists;
2. preserve the originating harness's native behavior in its driver;
3. add shared vocabulary only after the semantics are demonstrated across the
   drivers that use it;
4. keep agent-specific data and controls behind that driver; and
5. expose unsupported or unavailable behavior honestly rather than emulating a
   stronger guarantee.

A standard protocol may later be useful for reaching agents without a stable
native surface, but it would be another reviewed driver. It would not replace
the native Codex and Claude paths or become Caffold's canonical product schema
by default.

## Code and verification map

```text
caffold/src/agent.rs                    shared agent vocabulary
caffold/src/agent/driver.rs             closed driver choice and shared Task operations
caffold/src/agent/codex.rs              Codex entry point
caffold/src/agent/codex/                app-server transport, protocol, readiness, contract
caffold/src/agent/claude.rs             Claude entry point and live session state
caffold/src/agent/claude/               protocol, transcript, settings, tools, runner client
caffold/src/app/tasks/runtime.rs         per-Task routing and cross-agent orchestration
caffold/src/app/tasks/runtime/bridge.rs  Codex runtime bridge
caffold/src/app/tasks/runtime/claude_bridge.rs
                                        Claude runtime and tool bridge
caffold/src/app/tasks/detail.rs          canonical Detail and history membership
caffold/src/app/tasks/events.rs          observation reconciliation and publication
frontend/pages/(task-workspace)/tasks/task-events.js
                                        exact-identity projection operations
frontend/pages/(task-workspace)/tasks/(detail)/(task)/layout.js
                                        snapshot/delta application and rendering cache
runners/claude/                         transport-only runner crate
```

Deterministic Rust and browser suites use stand-in transports and fixtures.
The ignored Codex and Claude live suites verify the real installed agents and
may consume model usage. Commands and prerequisites are indexed in
[Testing Caffold](../development/testing.md).
