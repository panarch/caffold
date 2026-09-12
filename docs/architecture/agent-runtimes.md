# Agent Runtimes

This document owns Caffold's implemented multi-agent boundary: why supported
agents keep separate native integrations, what the Task application shares,
and which state and lifecycle remain specific to Codex, Claude Code, or Grok.

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
   control protocols. Grok is reached through the Grok CLI's leader and its
   stdio agent protocol.
2. **Do not copy state the agent already owns.** Codex threads remain in
   app-server; Claude conversations remain in Claude's transcript files; Grok
   sessions remain in the leader and its session files.
3. **Share only verified product semantics.** Conversation, turns, activity,
   approvals, and Task operations have a Caffold vocabulary. Wire methods,
   payloads, models, and permission modes remain agent-specific.
4. **Make differences explicit.** The driver set is a closed Rust enum. A
   capability that one agent has and another lacks requires an explicit match
   arm at the use site instead of falling through a runtime default.

This gives every supported harness a first-class path without defining the
product by their lowest common subset.

## Boundary

```text
Browser / PWA
      |
Tasks application
      |
Caffold conversation, event, approval, and driver vocabulary
      |                          |                          |
Codex native driver        Claude native driver        Grok native driver
      |                          |                          |
Codex app-server          Claude CLI protocol       Grok stdio agent protocol
      |                          |                          |
persistent Codex daemon   Caffold runner -> claude   Caffold-started grok leader
```

`caffold/src/agent/` is the boundary. Its top-level conversation and approval
types are the smallest vocabulary the product actually renders. Each driver
translates its agent into that vocabulary at one edge; the Tasks application
and browser do not parse provider wire messages.

`caffold/src/agent/driver.rs` contains the closed `Driver` choice and the
operations Caffold has verified for every agent:

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
model for a New Task therefore chooses Codex, Claude, or Grok without guessing
from the model name. The managed Task row persists that provider before the Task
appears in the navigator.

An existing Task cannot change providers. Its conversation identifier,
history, cwd ownership, permission semantics, and process lifecycle all belong
to the agent that created it. Switching a Task in place would produce a new
conversation while presenting it as continuity, so Caffold refuses that model
instead of emulating it.

Codex, Claude, and Grok models may expose different effort levels, fast modes,
and permission modes. The composer shows what the selected agent offers. A choice
travels back under the agent's own name, and the driver verifies it before a
conversation or turn is created. Caffold never invents a common permission
profile and does not silently substitute one agent's default for another's.

## Archive and permanent deletion

Archive is a Caffold membership operation with a provider-specific side effect.
Caffold asks Codex to archive its thread. Claude has no corresponding archive
state, so Caffold asks it to close any live session. Grok has none either:
Caffold asks the leader to close the session, which keeps its record, and the
Task's binding stays. A successfully read Active
status still blocks the operation, but provider acquisition, description, or
archive failure is logged and does not block the safe local worktree and
membership transition. When no canonical conversation was read, the response
uses the unavailable projection from Caffold's archived row rather than
inventing provider state.

Restoring remains provider-dependent: it reverses the Codex archive, while a
Claude restore makes the retained Task active again only when its transcript
still exists, and a Grok restore only when the session's directory is still
there under Grok's home.

Permanent deletion is available only after archive and asks the recorded
driver to forget the conversation before Caffold deletes its own row. Codex
uses app-server thread deletion. Claude removes the exact transcript file and
the same-session directory beside it, including subagent conversations and
spilled tool output, after deriving and validating the path from the Task's
conversation ID and cwd. Grok closes and deletes every session the Task's
binding records — the current one and those a worktree move left behind — and
then removes the binding; the CLI keeps its per-directory prompt history. None
of these paths deletes a Git branch.

## Runtime comparison

| Boundary | Codex | Claude Code | Grok |
| --- | --- | --- | --- |
| Native surface | Experimental v2 app-server protocol | CLI stream-json plus bidirectional control protocol | Leader socket with stdio agent bridges speaking JSON-RPC in ACP's shape plus `_x.ai` extensions |
| Long-lived process | User-global app-server daemon | One Caffold runner per data directory, with one `claude` child per live session | One `grok agent leader` Caffold starts on its own socket and leaves running |
| Caffold transport | Disposable proxy child and JSON-RPC/WebSocket connection | Unix-socket runner connection carrying raw newline-delimited frames to child stdio | One `grok agent … stdio` bridge child per backend, multiplexing every Grok session |
| Conversation history | App-server thread and paged turns | Claude-owned JSONL transcript read tolerantly by Caffold | Leader-owned session record, read in turn windows |
| Active-turn survival across backend replacement | The daemon owns the turn; a new proxy reconnects | The runner owns the child; a new backend reattaches and asks the session for current state | The leader owns the turn; a new bridge loads the session and reads the record for the turn's end |
| Working directory | Reported and owned by the Codex thread | Persisted with the Caffold Task and supplied whenever the Claude session starts or resumes | Persisted with the Task; the driver's binding names the native session that runs there, and a worktree move forks the session |
| Caffold-served Task tools | Caffold-owned HTTP MCP config on thread start and resume; calls from dynamic tools persisted by pre-MCP threads remain supported | In-process MCP server declared whenever the session is initialized | Caffold-owned HTTP MCP server declared on session start and load, bound to the Task before its session exists |
| Current-plan instruction carrier | Caffold MCP `initialize` result `instructions` | Initialize `appendSystemPrompt` on fresh and resumed sessions | `_meta.rules` on a new session and the MCP `initialize` instructions on every load |
| Readiness | Typed, blocking installation and app-server readiness | Diagnostic status; an attempted operation reports its own failure | Diagnostic status; an attempted operation reports its own failure |
| Idle release | A thread subscription may be dropped when no viewer, request, or runtime lease remains | The session stays attached; detaching and immediately reattaching is not a free operation | The session stays loaded on the bridge; the leader is not asked to unload |

The table describes ownership, not a feature score. Every driver supports the
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

Caffold names each prompt and steering message it sends to Claude; the name
is the stdin frame's `uuid`. Claude files a prompt under that name as the
transcript row's `uuid` and a steering message as the queued command's
`source_uuid`, so the live turn and the transcript turn share one identity. A
prompt's turn opens, and the prompt request answers with that identity, when
the runner has accepted the frame. A user-role frame without tool results is
not drawn; the transcript reader applies the same rule to user rows. Prompt
echoes from sessions started with `--replay-user-messages` are such frames.

A Claude child's exit ends its open turn: interrupted when Caffold asked the
session to end, failed otherwise. A runner lost under a session Caffold did not
ask to end leaves the session unreachable; no turn is ended.

Claude session activity and turn lifecycle are independent provider facts.
Each Claude child reports its moves between idle, working, and requiring action;
the same state is returned when a surviving child is initialized again. Caffold
projects that observation onto the Task's activity without creating,
identifying, or ending a turn; while a turn Caffold asked for on its own
account runs, such as a depth change, the Task reads as idle. Claude's turn
ledger is written by Caffold's prompt and steering submissions, Claude's result
frames, the child's exit, and the transcript when a replacement takes up a
working session. Codex status and turn lifecycle retain their app-server-owned
coupled path through the same shared Task state. An initialize answer is only a
current snapshot: until this backend sees a live activity frame, it retains the
turn-based fallback for a child that may have survived from before activity
events were enabled.

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
replay rule. A replacement that greets a working session takes up the newest
transcript turn. On Claude's next message or result frame it reads the
transcript once more; if the newest turn differs, it ends the turn it took up as
completed and takes up the newer one.

New authenticating Claude starts pass through one backend-owned gate. Direct
measurement showed that two young CLI processes can refresh the same account
credential concurrently and cause the service to revoke the login. Caffold
therefore serializes and spaces new session and one-off authenticated starts.
Reattaching to an already running child is not counted as another start. The
runner remains transport-only and does not implement this account policy.

The runner's lower-level process, relay, stale-child, and test contract is
documented in [caffold-claude-runner](../../runners/claude/README.md).

## Grok lifecycle

The Grok CLI's programmatic surface is its own leader: a long-lived process
that holds sessions and runs turns, reached over a Unix socket by stdio agent
bridges that speak a JSON-RPC protocol in ACP's shape with Grok's `_x.ai`
extensions. Caffold starts a leader of its own on `~/.grok/leader-caffold.sock`
when a Grok operation first needs one, attaches to that leader when it is
already listening, and keeps one bridge child per backend. The leader is Grok's
process: Caffold neither stops it nor drives the CLI's own leader, and it is
started in its own process group so that a signal to Caffold does not end it.

The leader owns sessions, turns, approvals, and the session record. A bridge
that dies mid-turn is an observation gap, not a failure: the turn finishes
under the leader, and the next load reads its end from the record. A replaced
leader, announced as `_x.ai/leader_reconnected`, ends the running prompt with
the leader's error and makes the session one to open again. A prompt Caffold
sent is never sent again on the Task's behalf.

Caffold names each session and turn it creates — a UUIDv7 Task identifier
sent as `session/new`'s `_meta.sessionId`, a turn identifier sent as
`session/prompt`'s `_meta.promptId` — and Grok keeps those names in its queue,
chunks, completion, and record. A Grok session does not change directory, so a
worktree move forks it. The driver-private binding file under
`<data dir>/grok/bindings/<task id>.json` records which native session the
Task runs on and where, which sessions it left behind, and how far a move has
got; it is Caffold's recovery data, never conversation state. The Task
application sees only the Task identifier.

Loading a session replays its record as notifications and takes up the
leader's pending permission requests under their original tool call identity.
Every frame names its session, and the bridge generation and the replay flag
keep a late or repeated report from changing the conversation. Activity is the
leader's word: a turn's end comes from `turn_completed` or the prompt's answer,
and whether the session is still working comes from the leader's session
summaries. History is read from the record in turn windows, and a turn Caffold
watched from its start keeps its live items.

Grok's model catalog, reasoning efforts, and the three permission modes Caffold
names for it — ask each time, automatic, full access — are read from the
leader and applied with `session/set_config_option`; the permission mode is
fixed when the session is created. Images are sent as prompt blocks. The
Settings report reads the installation without touching any of this: the
executable by running it, the leader through `grok leader info`, the connection
as the bridge stands, and the account through a leader that is already
listening.

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
content blocks. The Grok driver translates session updates — live, replayed,
and stored — and `_x.ai` notifications; a frame marked as a replay is not a
new event. A Claude `thinking` block that carries text is the agent's
progress note between tool calls and reads as an agent message; an empty one
reads as reasoning with nothing to show. Unknown optional events may be ignored
or presented as generic tool activity; missing load-bearing fields fail
explicitly. The provider's raw protocol does not escape into Task or frontend
state.

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
projection. The handoff adopts the confirmed backend position immediately,
including when an answer arrived before the prompt response. For a turn read
from history first, a live report joins under its exact identity: it updates the
item that identity already names, or adds a new item that continues the turn.
Only a later history read that leaves such a live or accepted report unlisted
makes the turn's membership unresolved. Content, proximity, and arrival order
are never substitutes for that identity.

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

`TaskEvents` owns one retained conversation projection. `TaskSessions` retains
turn lifecycle metadata and coordinates provider reads; it does not keep a
second long-lived copy of turn items. A full `Turn` comes from a history read.
Start and end reports carry only `TurnState`; named items carried by a provider
notification become separate item updates. A partial completion report cannot
replace the turn's item membership. Provider-specific inclusion flags remain
inside that provider's adapter.

The projection records provider history, live lifecycle observations, accepted
submissions, and local projections with explicit roles. It reconciles a history
read when that read is accepted, under the same owner as live publication.
Session causality protects exact-identity live updates accepted after the read
began. A turn observed continuously from its start retains its live item set
and stable positions even if a history read uses different IDs. Unmatched IDs
from a partial attachment or recovered source remain distinct. Their contents,
timestamps, or proximity cannot authorize a guessed match.

Retention is by whole turn. Each Task protects its latest turn and one historical
continuation selected by the most recently requested successful older-page read.
A failed request retains the previous selection; a late response cannot change
the selection after a newer request. When the total exceeds 300 distinct
conversation items, least recently used, unprotected completed turns are evicted
whole. Updates to the same item do not add to the count. Protected turns may
exceed the budget. Unprotected empty completed turns are discarded after the
response and continuation have been captured. This is an item retention policy,
not a byte bound, prefetch target, or limit on the browser's retained pages.

A provider generation change or confirmed observation gap withdraws history
validity and rejects pending reads from that observation lifetime. Retained
reports may still be displayed without claiming complete membership. The next
history read that lists a turn resolves its membership again, unless a live or
accepted report of that turn remains unlisted; Caffold-owned records such as
approval questions are never listed and do not keep a turn unresolved. An ID
mismatch, capacity threshold, cache miss, compaction, or individual page failure
does not establish an observation gap. Browser reconnection while the provider
subscription continues reuses the same projection. Cache maintenance does not
clear browser history or initiate provider reads. Older-page requests from
scrolling or bounded gap recovery
read on a cache miss; concurrent readers of the same native page share one
in-flight operation, keyed by Task, provider generation, observation epoch,
native cursor, and page limit. Browser slice offsets share that operation;
cancelling one HTTP consumer does not cancel it for other readers. Completed
results return to the existing cache policy rather than a second permanent
history store. An observation change rejects the old result; an
uninterpretable continuation fails that request rather
than restarting a traversal. Limited recovery may leave unmatched display items
or delay their reconciliation instead of repeatedly reading the provider.

### Projection publication

Every accepted Task-event delta receives a process-local, per-Task
`eventRevision` when it enters the conversation projection. A Detail snapshot
captures the retained observations and a watermark that covers them in the
same backend owner. This publication sequence is independent of the Task
session `revision` used to arbitrate canonical reads and Task metadata. It
establishes whether an independently delivered conversation record is covered
within the exact identity or membership extent that declared it. Task metadata
revisions and publication revisions outside that extent do not reject it. This
sequence is not item identity, provider causality,
conversation position, or time.

Every Detail answer declares the extent of the projection it owns as an
inclusive backend position range, `eventsRange`, or declares none. A
current-page answer with established membership owns its first event onward. An answer bounded to
`TASK_DETAIL_EVENT_LIMIT` events owns its first kept event onward; the turn
boundary events it repeats from before that point update by identity without
widening the extent. An older cursor page, whether older turns or the earlier events of a page
already answered, owns exactly the span of the events it contains. A
`historyLoading` answer, retained evidence after an observation gap, or a page
with unresolved source membership declares no extent. Such an answer owns the
exact identities it contains and cannot prove that an absent, previously
readable item was deleted.

The agent still owns the meaning of a permission. Caffold owns the human answer
vocabulary—allow, allow always, deny, and deny and stop—and each driver offers
only decisions its agent can carry out. See
[Security and Approvals](security-and-approvals.md) for the exact mappings.

## Current plan document convention

Caffold owns one provider-neutral instruction describing the optional
[current plan document pair](../product/workflows.md#current-plan-documents).
It tells an agent when and how to maintain the two ordinary Markdown files but
does not require every Task to create them. Filesystem content remains the
source of truth; the shared agent vocabulary has no plan entity, lifecycle, or
progress writer.

Each driver carries that same meaning through its native initialization
boundary. Codex returns it as the Caffold MCP server's `instructions` on MCP
initialization for thread start and resume. This leaves the project's Codex
`developer_instructions` and Caffold's separately recorded first-turn naming policy
unchanged. Claude supplies it through `appendSystemPrompt` on every session
initialize; only a fresh Task appends the one-time naming instructions, while
a resumed or reattached session receives the plan convention alone. Grok
receives it as `_meta.rules` when a session is created, with the one-time
naming instructions appended for a new Task, and as the Caffold MCP server's
`instructions` on every load.

No driver enables a native Plan or collaboration mode, translates native
plan events, or exposes structured clarification questions for this feature.
Planning decisions remain normal conversation, and the browser projects only
the filesystem pair. Provider-specific transport tests verify both fresh and
resume carriers without promoting their wire fields into the Tasks
application.

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
- Grok receives the same authenticated HTTP MCP server through its own door,
  declared on session start and load with a header bound to the Task before
  the session exists; the binding stays bound while the session is open.

All three MCP catalogs use the Task-owned base names `rename_current_task` and
`isolate_current_task`; Claude's transport qualifies them as
`mcp__caffold__...` and Grok's as `caffold__...`, while Codex presents the base
names directly. Only the pre-MCP Codex dynamic-tool compatibility path accepts
the historical `rename_current_thread` name.

The application handles both requests through the same Task and Git lifecycle.
Only delivery and cwd movement differ. Codex accepts a new cwd for the next
turn. A Claude process changes cwd only between turns, so Caffold completes the
Git preparation, ends the setup turn, then moves the session before another
turn can begin. A Grok session is forked into the worktree when the setup turn
ends, and the Task is re-bound to the copy. The full safety and recovery
contract belongs to [Managed Worktree Lifecycle](worktree-lifecycle.md).

## Source of truth

| State | Owner |
| --- | --- |
| Codex conversation, cwd, turns, and runtime status | Codex app-server |
| Claude conversation history | Claude's transcript file |
| Live Claude process and pending control requests | Claude process, held and relayed by the Caffold runner |
| Grok sessions, turns, approvals, and the session record | Grok leader |
| Which native session a Grok Task runs on, and a worktree move in progress | Caffold's driver-private binding file |
| Task membership, provider, display name, Section placement, composer state, and managed-worktree recovery | Caffold Redb |
| Current plan documents and checklist markers | Filesystem under the Task's effective working directory |
| Files, diffs, branches, and commits | Git checkout or worktree |
| Presentation, selection, and transient request state | Browser/PWA |

When an owning source is unavailable, Caffold reports that condition or uses a
strictly Caffold-owned fallback. The selected Active-list row may keep Detail's
header identity and Archive action present, and an archived row may keep its
list entry present. Neither becomes canonical conversation content or status;
Caffold does not infer provider state from the browser, a prior event, or a
copied transcript.

## Extending agent support

Caffold currently compiles support for Codex, Claude, and Grok. It does not
discover drivers, load provider code, or implement ACP at runtime. This closed set is an
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
the native Codex, Claude, and Grok paths or become Caffold's canonical product
schema by default.

## Code and verification map

```text
caffold/src/agent.rs                    shared agent vocabulary and plan convention
caffold/src/agent/driver.rs             closed driver choice and shared Task operations
caffold/src/agent/codex.rs              Codex entry point
caffold/src/agent/codex/                app-server transport, protocol, readiness, contract, MCP carrier
caffold/src/agent/claude.rs             Claude entry point and live session state
caffold/src/agent/claude/               protocol, transcript, settings, tools, instruction carrier, runner client
caffold/src/agent/grok.rs               Grok entry point, sessions, MCP carrier, and the Settings report
caffold/src/agent/grok/                 leader transport, protocol, binding file, history, translation, worktree switch
caffold/src/app/tasks/runtime.rs         per-Task routing and cross-agent orchestration
caffold/src/app/tasks/runtime/bridge.rs  Codex runtime bridge
caffold/src/app/tasks/runtime/claude_bridge.rs
                                        Claude runtime and tool bridge
caffold/src/app/tasks/runtime/grok_bridge.rs
                                        Grok runtime bridge
caffold/src/app/tasks/codex_mcp.rs       the HTTP MCP doors Codex and Grok call Caffold's tools through
caffold/src/app/tasks/detail.rs          canonical Detail and history membership
caffold/src/app/tasks/events.rs          observation reconciliation and publication
frontend/pages/(task-workspace)/tasks/task-events.js
                                        exact-identity projection operations
frontend/pages/(task-workspace)/tasks/(detail)/(task)/layout.js
                                        snapshot/delta application and rendering cache
runners/claude/                         transport-only runner crate
```

Deterministic Rust and browser suites use stand-in transports and fixtures;
the Grok driver's suite plays the leader from recorded `grok 1.0.30` answers.
The ignored Codex and Claude live suites verify the real installed agents and
may consume model usage. Commands and prerequisites are indexed in
[Testing Caffold](../development/testing.md).
