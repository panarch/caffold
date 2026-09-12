# Security and Approvals

This document defines the security and approval boundary for deployment on
personal hosts and trusted private networks.

Caffold is a remote control surface for a local development machine.

The supported deployment boundary is one trusted host accessed locally or over
a trusted private network. Caffold does not currently provide the
authentication and authorization boundary required for direct public-internet
exposure.

## Trust Boundary

Expected deployment:

- personal host machines
- private network access such as Tailscale
- no public unauthenticated exposure
- browser access to the local filesystem and agent command execution only
  through the Caffold backend

Caffold should still assume that remote command execution is sensitive.

## Approval Principles

- Show the cwd and exact command when a command approval supplies them.
- Show the complete requested capability profile before permission approval.
- Distinguish allowing once, for the session, and with the proposed persistent grant.
- Keep every approval decision visible in the canonical conversation.
- Make refusal a first-class outcome, both when the turn continues and when it
  stops.
- Avoid silent destructive operations.

## The Approval Vocabulary

Caffold's approval vocabulary is `allow`, `allowForSession`, `allowAlways`,
`deny`, `cancel`, and `denyAndStop`. A request advertises which answers it
accepts, and answering with one it did not offer is refused before anything
reaches the agent. Cancel answers the request without asking to interrupt the
turn; deny and stop explicitly requests a turn interruption.

Caffold owns the answer, not the permission. Allowing something always tells the
agent to apply the grant the agent itself proposed, so the permission model
stays the agent's and Caffold never composes one.

A request reaches the interface already written for a person to read: a title, a
reason, and whichever specifics it carries — the command, the working directory,
the network destination, the requested access as labelled rows, or the tool
context and original JSON arguments. The driver
writes those, because reading a permission profile means understanding it, and
the driver is what understands its own agent.

An approval's identity is Caffold's; the request it must be answered on is the
agent's. The driver holds the pairing between the two, so nothing above it
interprets a protocol id. A valid answer claims the pending request once before
sending it. The runtime completes that reply even if its HTTP caller
disconnects; the card is retired when the send completes, the provider resolves
it, or its turn ends. Missing pairing or a failed send retires the card as
unavailable. Codex connection loss also retires that connection's cards, and a
lost Grok bridge retires that session's; a provider replay on the replacement
connection creates a new request instance, which an older completion cannot
retire. Pending and replying
are ephemeral UI request phases, separate from the provider's thread status.

## General Clarification Questions

General clarification uses ordinary chat. When Codex sends
`item/tool/requestUserInput` or Claude sends `can_use_tool` for the built-in
`AskUserQuestion`, the driver answers automatically with Caffold's interaction
policy: explain why the input is needed and the tradeoffs between options,
ask in the conversation, and wait for the person's reply through the composer.
These requests do not create pending approval cards or user permission decisions.

Claude receives the policy through the tool-denial message. Codex receives a
developer message through `thread/inject_items`; after that request is
acknowledged, the driver settles the structured question with an empty answers
map. An RPC error alone would discard the explanation inside app-server. If
Codex feedback injection fails, the driver rejects the outstanding request.
Both drivers report delivery failures through the existing diagnostics instead
of claiming feedback was delivered.

This handling applies to received clarification requests. Commands, filesystem
and network access, MCP tool authorization, and other permission requests still
use their approval paths below. Provider history and live status retain their
existing ownership; Caffold adds no clarification ledger or waiting-state overlay.

## Caffold-Served Task Tools

Task naming and managed-worktree preparation are Caffold-owned operations, not
general agent permissions. Caffold declares that closed tool set through each
agent's native extension point and allows those calls without adding another
approval card. The tool still enforces its own Task and Git lifecycle checks;
an unknown tool or an unmanaged conversation is refused.

Codex and Grok reach this surface through HTTP MCP endpoints on the Caffold
server, `/api/codex/mcp` and `/api/grok/mcp`, which share one handler and one
set of bindings; the bound Task's recorded agent decides which driver carries a
call out. Each request-scoped Codex app-server config carries a private opaque
binding header, and each Grok session declaration carries one as an HTTP
header.
A Task-scoped call is authorized only by that header together with its signed
MCP session. The session authenticates the provider thread ID and a digest of
the binding header under one installation-local HMAC key, so neither the model
nor tool arguments can choose another Task. The bootstrap and Codex
reinitialization sequence that establishes the pair belongs to
[Codex app-server integration](codex-app-server.md#thread-subscription-lifecycle).
A Grok Task's identifier is known before its session exists, so its binding is
bound to the Task before `session/new` and the first `initialize` already
answers with the signed session. Grok initializes the connection while the
session is created and may do so again later, so the binding stays bound while
the session is open and is let go when the session is closed, erased, or loaded
again under a new binding.

Only the private `codex-mcp/signing.key` file survives backend generations.
Bootstrap bindings and provisional sessions remain process-local and are
discarded after promotion; Caffold writes no Task, thread, grant, connection,
or revocation records for this transport. A replacement backend validates an
already initialized binding-and-session pair statelessly with the same key. A
successful resume creates another pair without revoking an older live
connection, while a failed start or resume removes only its staged bootstrap.
When the Task lifecycle deletes the managed thread, the runtime membership
check rejects every Task-scoped tool call from older sessions even though the
signed transport value itself has no per-Task revocation ledger.

Tokens remain in request headers and request-scoped app-server configuration,
never in the endpoint URL. Caffold does not project that configuration into
Task events or conversation history, and it redacts binding, provisional, and
signed session shapes plus the binding header from provider errors and
diagnostics before they can reach ordinary logs or Task-facing error state.
Missing headers, forged values, mismatched pairs, another installation's
session, and pending bootstraps fail closed.

This capability protects one Caffold integration inside the trusted-host
deployment boundary; it is not browser authentication or authorization for
public-internet exposure, nor is it a boundary against code that can already
read Caffold's private data directory or inspect its process as the same host
user. Because the route shares the main Caffold server, it can be reachable
even when that installation is used only with Claude. The signing key is opened
lazily only for a signed-session operation, route reachability does not start
Codex or Grok or select a Task, and an unavailable key or a request without an
install-issued capability fails closed without preventing a Caffold service
that lacks one of the agents from starting.

Codex, Claude, and Grok expose the same Task-owned MCP base names:
`rename_current_task` and `isolate_current_task`. Claude's provider transport
qualifies those names as `mcp__caffold__...` and Grok's as `caffold__...`;
Codex's does not. The historical Codex
`rename_current_thread` name is accepted only for a dynamic-tool definition
already persisted on a pre-MCP thread, never through the current MCP endpoint.

## The Mode a Turn Runs Under

A turn runs under the mode its composer shows. The modes on offer are the
driver's answer for the agent and the model that were chosen, and the one on
display travels back with the prompt whether or not a person touched the
control, so a Task never starts under something the composer did not say.

Caffold names no mode of its own, and sends one only while the list that
offered it is the list in hand and still allows it. A first list still being
fetched, a model change still being answered, or an agent that could not be
reached leaves the prompt carrying no mode, and the control says the agent's
own default will be used. A mode the current list withholds — one the chosen
model cannot work under — is replaced by the one that list names instead.
Sending a name the list does not stand behind would be refused at the moment
the turn starts.

## Codex Execution Approvals

Codex app-server owns command execution and permission requests. Caffold
presents each request and result without introducing a separate command runner,
permission ledger, or alternate process state.

Current rules:

- command cwd follows the Codex thread workspace;
- command approval cards show the requested command and cwd when supplied;
- network-aware command approvals show their destination and requested
  additional permissions even when no command text is present;
- permission approval cards show the reason, cwd, and complete requested
  network and filesystem profile;
- the approval modes offered are assembled by the Codex driver from the
  permission profiles the workspace allows and the reviewer setting, and reach
  the interface already worded;
- `allowForSession` maps to `acceptForSession` for command and file-change
  requests; these requests do not offer `allowAlways`;
- allowing a permission request returns the original server-requested profile,
  scoped to the turn or the session, while denial returns an empty profile;
- a permission request cannot stop a turn, because Codex's permission response
  has no way to say so, and it therefore does not offer that answer;
- command output and exit status remain attached to the canonical turn;
- long-running commands expose visible running state;
- a command a person refused reads as declined rather than failed;
- approval outcomes are sent back through the original app-server request.

Allowlists, deny lists, or command classes require a separate policy before they
can change the approval flow.

## Codex MCP Tool Approvals

The Codex adapter recognizes input-free `form` elicitations marked
`_meta.codex_approval_kind = "mcp_tool_call"`. The card shows the tool title,
request message, server, optional app and description, and the original JSON
arguments. Display metadata may label and order arguments, but cannot replace
their values or omit undisplayed arguments. Non-object arguments remain one
JSON value. Missing optional presentation fields do not discard the request.

The request offers allow, deny, and cancel, plus the session and persistent
choices named by its `persist` metadata. Unknown scope strings add no choice.
The response uses the original JSON-RPC ID:

| Caffold decision | MCP action | Content | Response metadata |
| --- | --- | --- | --- |
| `allow` | `accept` | `{}` | none |
| `allowForSession` | `accept` | `{}` | `persist: "session"` |
| `allowAlways` | `accept` | `{}` | `persist: "always"` |
| `deny` | `decline` | `null` | none |
| `cancel` | `cancel` | `null` | none |

Cancel skips the MCP call; it does not send `turn/interrupt`. The browser
renders the offered decisions and does not interpret Codex metadata. General
input forms, URL elicitations, and malformed approval contracts receive an
explicit unsupported-request error, without creating an unanswerable card.

## Claude Execution Approvals

Claude asks on the same channel it speaks on, as a `can_use_tool` control
request that blocks the turn until it is answered. It asks only because the
session is started with `--permission-prompt-tool stdio`; without that flag the
agent never asks and Caffold would show a conversation that appeared to need no
permission at all.

Current rules:

- command cwd follows the Task's working directory, which is the directory the
  session's process was started in;
- an approval card shows the tool the agent named and, for a shell command, the
  command itself;
- a tool call does not imply an approval card — the agent's own classifier
  settles obviously safe calls without asking, so an unasked call is a call that
  did not need asking rather than one that slipped past;
- the offered answers remain allow, allow always, deny, and deny and stop;
  the driver rejects session-only and cancel decisions;
- allowing always hands back the permission suggestion the agent itself
  proposed, unread;
- denying and stopping is offered, and is carried out as a denial followed by an
  interrupt, because the agent's permission answer has no way to say "and stop";
- a call a person refused reads as declined rather than failed, which Caffold
  can say because Caffold is what refused — the agent reports a refusal as a
  failed tool result, which is what it is from where the agent stands;
- the approval modes offered are named by the Claude driver rather than asked
  for, because the agent publishes no list and what each mode gives up is
  knowledge about the agent;
- a control request Caffold did not register for — a hook callback, an
  in-process tool — is answered rather than left to block the turn.

## Grok Execution Approvals

Grok asks through its leader, as a `session/request_permission` request on the
bridge that has the session loaded, and the turn waits until it is answered.
Grok's own classifier runs plainly safe commands without asking, so an unasked
call is one that did not need asking.

Current rules:

- command cwd is the Task's working directory as the driver's binding records
  it, which is where the session runs;
- an approval card shows the command for a shell call and, for a tool call,
  the server and tool the agent named with the arguments it gave;
- the offered answers are allow, allow always, and deny, taken from the
  options Grok attached to the request — `allow_once`, `allow_always`, and
  `reject_once`; the driver rejects session-only, cancel, and deny-and-stop
  decisions because Grok offers nothing they would mean;
- allowing always is Grok's own memory: it keeps the command allowed for that
  working directory, shared by every Caffold Task there and kept apart from the
  CLI's own sessions in the same directory;
- denying ends the turn, because a rejected tool call ends a Grok turn as
  cancelled; the refused call reads as declined and the turn as interrupted;
- Grok's `reject_always` option is never offered, because it is remembered for
  the directory across sessions;
- the mode a session runs under — ask each time, automatic, or full access —
  is fixed when the conversation is created, and a later prompt asking for
  another mode is refused with that reason;
- a request left unanswered when the bridge goes away is retired as
  unavailable; the leader asks again when the session is next loaded, under the
  same tool call identity and a new request.

## Git Mutations

Caffold does not expose direct Git mutation controls. Git mutations happen
through instructions to the Task's agent or manual terminal work.

## Worktree Deletion

Caffold removes a worktree only as part of an explicit Archive action and only
when a matching `managed_worktrees` ownership record proves that Caffold created
the UUID-derived path. The live Git common directory, branch, managed root, and
clean state are revalidated before removal.

Dirty managed worktrees block Archive; there is no force-delete confirmation
path. External or merely cwd-derived worktrees are never deleted by Caffold.
Archive retains the managed branch and record so Restore can recreate the same
owned path.

## Tailscale Assumption

Tailscale is a supported private-network transport, not a substitute for host
trust. Direct public-internet deployment is outside the current supported
boundary. Supporting it requires application authentication, authorization,
and audit controls and remains [planned product work](../product/roadmap.md).

The backend is the only Tailscale integration owner. It derives status from the
local CLI and accepts only fixed commands for Caffold's localhost target on
private HTTPS port 443. It refuses a foreign mapping instead of replacing it.
Status and the private Tailnet URL are readable through the tailnet, but Serve
mutations require a loopback Host and, for browsers, the matching Origin.
The read-only QR resource accepts only a bounded canonical `https://*.ts.net/`
address and returns a fixed SVG image; it cannot change Serve state or encode an
arbitrary payload. Funnel, arbitrary targets, ACLs, and account administration
are not exposed.

## Voice Input

- Model installation is an explicit first-use action and uses a pinned URL,
  byte length, and SHA-256 checksum.
- The browser sends microphone audio only to its same-origin Caffold host.
- The backend bounds duration and request size, accepts only the browser's
  16 kHz mono 16-bit PCM WAV contract, processes samples in memory, and never
  persists raw recordings.
- Transcription is host-local. Tailscale protects remote transport but is not a
  speech service or inference dependency.

## Web Push

- Subscription mutations require a same-origin request inside the existing
  trusted-host boundary. This check is not a user authentication system.
- The existing Caffold database persists browser Push endpoints, subscription
  keys, revocations, and the server's VAPID private key. API responses and
  frontend assets never expose the private key or active subscription secrets.
- Endpoints, subscription keys, and the VAPID private key are not written to
  application logs. Delivery diagnostics identify only a short installation ID
  and sanitized outcome.
- Delivery makes an outbound HTTPS request to the browser vendor's Push Service.
  The provider receives the endpoint and Web Push headers, while the payload is
  encrypted and contains only Task/turn identifiers, terminal status, a bounded
  Task name when available, and the deterministic notification tag.
- A notification that a Task is waiting for an answer carries the same Task
  identifier, name, and tag, and nothing of the request itself. The command,
  tool, requested profile, cwd, network destination, and reason a person reads
  in the conversation are never sent to a Push provider or shown on a lock
  screen.
- Push delivery failure never changes canonical Task state or foreground SSE
  behavior, and never resolves, withdraws, or delays an approval.
