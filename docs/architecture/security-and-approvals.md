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
retire. Judging, pending, and replying
are ephemeral UI request phases, separate from the provider's thread status. A
request being judged has not been shown to anyone, so a request that ends there
resolves nothing in the conversation.

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

## Caffold-Served Tools

Task naming, managed-worktree preparation, and Notes are Caffold-owned
operations, not general agent permissions. Caffold declares that closed tool set
through each agent's native extension point and allows those calls without
adding another approval card. Each tool still enforces its own checks, such as
the Task and Git lifecycle for the Task tools and a Note's content version for
the Notes tools. An unknown tool or an unmanaged conversation is refused.
Caffold keeps no Note history, so a Notes tool that replaces or deletes content
cannot be undone.

Codex and Grok reach this surface through HTTP MCP addresses on the Caffold
server, `/api/codex/mcp` and `/api/grok/mcp`. Each address has its own handler
and its own bindings, and the bound Task's recorded agent decides which driver
carries a call out. Each request-scoped Codex app-server config carries a
private opaque binding header, and each Grok session declaration carries one as
an HTTP header.
A Task-scoped call is authorized only by that header together with its signed
MCP session. The session authenticates the provider thread ID and a digest of
the binding header under one installation-local HMAC key that both addresses
use, so neither the model nor tool arguments can choose another Task. An
address issues sessions only for the bindings its own agent was given; a signed
pair is then verified with that key wherever it arrives, so the two addresses
are only the names each agent is given, not an isolation boundary between them. The
bootstrap and Codex reinitialization sequence that establishes Codex's pair
belongs to
[Codex app-server integration](codex-app-server.md#thread-subscription-lifecycle).
A Grok Task's identifier is known before its session exists, so its binding is
bound to the Task before `session/new` and the first `initialize` already
answers with the signed session. Grok initializes the connection while the
session is created and may do so again later, so the binding stays bound while
the session is open and is let go when the session is closed, erased, or loaded
again under a new binding.

Only the private `codex-mcp/signing.key` file survives backend generations; it
signs the sessions of both addresses.
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
user. Because both routes share the main Caffold server, they can be reachable
even when that installation is used only with Claude. The signing key is opened
lazily only for a signed-session operation, route reachability does not start
Codex or Grok or select a Task, and an unavailable key or a request without an
install-issued capability fails closed without preventing a Caffold service
that lacks one of the agents from starting.

Codex, Claude, and Grok expose the same MCP base names: the Task-owned
`rename_current_task` and `isolate_current_task`, and the Notes tools listed in
[Agent Runtimes](agent-runtimes.md#caffold-served-tools-and-worktrees).
Claude's provider transport qualifies those names as `mcp__caffold__...` and
Grok's as `caffold__...`;
Codex's does not. The historical Codex
`rename_current_thread` name is accepted only for a dynamic-tool definition
already persisted on a pre-MCP thread, never through the current MCP endpoint.

## The Mode a Turn Runs Under

A turn runs under the mode its composer shows. The modes on offer are the
driver's answer for the working directory, agent, and model that are chosen,
and the mode on display travels back with the prompt whether or not a person
touched the control, so a Task never starts under something the composer did
not say.

Caffold names exactly one mode of its own, **Ask Jev first**, and hands every
other mode back to its agent unread. That one is Caffold's because it says what
Caffold does rather than what an agent does; it is added to each list with the
same wording, since it means the same thing in all three. Choosing it runs the
agent under whichever of its own modes asks about the most — Claude's `default`,
Codex's `AskForApproval` profile, Grok's neither-flag session — and Caffold
answers what [Reviewed Approvals](#reviewed-approvals) settles. Each driver owns
that mapping, because which of its modes asks the most is the agent's knowledge.
It is offered with nothing configured and withheld with its reason, so a mode
nobody can use is never a feature nobody can find.

The composer takes a mode only from the list answered for the current choice:
the mode a person picked, then the one the Task or Section last ran under, then
the list's default, passing over any mode that list withholds, such as one the
chosen model cannot work under. What a Task records is the mode that was chosen,
not the agent's name for what it was run under: an agent reporting the posture
it is in describes the same state at a lower level, and never replaces the mode
a person picked. The composer asks for the list again when Jev's settings
change, because a mode can stop being withheld without the choice changing. The prompt waits while that list
is on its way. A list that cannot be read, or that allows no mode, is shown as
unavailable with its reason and holds the prompt until another model is chosen
or the page is reloaded, so a prompt never leaves without a mode.

## Reviewed Approvals

Under **Ask Jev first**, Caffold asks Jev before a person is asked. Jev is
TypeSafe's decision model: it answers typed questions rather than writing text,
so it can settle a request but cannot write a rule, a grant, or an explanation.

Jev either finds no reason to ask the person, in which case Caffold allows the
request once, or it does not, in which case the request is the person's. It is
never asked to refuse, to allow for a session, or to allow always. A persistent
grant would be the agent's own, and the next request of that shape would never
be asked about at all, which is the opposite of what choosing this mode says.
TypeSafe is asked once, with five seconds to answer. Its API sits behind
Cloudflare, whose firewall reads each request and refuses some that carry shell
commands before TypeSafe sees them. It refuses the same request every time, so
asking again cannot help, and the request is never reworded to get past it,
because Jev would then judge something other than what the agent will run. Such
a refusal lacks the request id TypeSafe's own refusals carry, which is how
Caffold records it as blocked rather than as a rejected key. A block, a
timeout, a rate limit, a rejected key, unreadable settings, an answer outside 0
to 1 — all of it ends the same way: the request is the person's, exactly as it
is without Jev.

Every question asked about a permission request or a prompt leaves one line in
the host's log, naming the Task and, for a permission request, the approval.
The line holds the answer and how long it took, or why there was none: the HTTP
status with the identifiers TypeSafe and Cloudflare gave the response, or the
connection error. The request itself is never written there.

The question is one gate, and it asks only whether the person should be asked
before the request runs. It does not ask whether the request is permitted:
finding positive authorisation for ordinary work is the thing the model is least
sure of, while recognising what warrants a person is the thing it is surest of.
Asking the question it answers well is what keeps ordinary work out of a
person's way.

Its baseline is the standard of a coding agent's automatic permission mode. What
the person has said comes before that baseline, in the order the person said it:
this turn's prompt, then this Task's record, then the rules from Settings. A
person who wrote no rules still gets judgements, so the key is the whole
requirement.

The threshold is not a setting. Each question is written so that being sure is
the answer that stops the agent, and one number says where sure begins.

Caffold asks before the request is shown. An allowed request records its arrival
and its answer together, so the conversation holds both and no card appears and
disappears; the phone is told only about a request that is actually waiting.
The resolved line says when Jev answered it, and carries the model version and
how much reason it found to ask.

A request Jev wanted a person for reaches the person with that answer on its
card. Only a request it found no reason to ask about leaves no card at all, so
every card naming a reviewer names how much reason it found. A card names no
reviewer when none answered: another mode, nothing configured, or a call that
failed, which the host's log records.

What reaches TypeSafe is one request as the agent's driver already wrote it for
a person to read — the command, the directory the driver named, the network
destination, the requested access, the grant root, and the tool with its
arguments — together with the rules from Settings, what this Task's own prompts
permitted, and the prompt that began the turn the request came out of. The
agent's own title and reason travel under a name that says the agent wrote them,
and Jev is told to read them as a claim about what is being asked rather than as
a reason not to ask. The model version is named
on every request, because a later version would quietly move where the threshold
sits.

Where the Task works is sent beside the rules instead, because it is Caffold's
own answer rather than anything the agent asked for. Rules are written about the
working directory, and most drivers name no directory when they ask: without it
a request under the Task's own checkout reads exactly like a path anywhere else
on the Mac, and rules about the working directory have nothing to measure
against.

The answer comes from the agent that is asking, because only a live session
knows where it is working now — and a request to approve proves there is one. A
Task that moved into a worktree works there while the row Caffold claimed it
from still names the checkout it started in, and sending that row instead puts
every file in the worktree outside the working directory, where rules that
refuse anything outside it refuse everything.

### What a Task's Prompts Permitted

Rules written once cannot say "in this Task, this far". A Task keeps that
separately, and only while its turns run under this mode.

A prompt sent under it is asked about once, with what the Task already keeps
beside it. One question decides whether it belongs in the record: it does when
it says what the agent may or may not do, and it does not when it only gives
work to carry out or only points at something said earlier. A prompt that
cancels an entry is read against the entry it cancels, which is why the record
travels with the question. A prompt that is both is kept whole, exactly as
it was typed, at the end of that Task's record. The record is read oldest first
and a later statement overrides an earlier one it contradicts; that order is the
order of the entries, never a comparison of the times beside them.

A statement in that record settles what the standing rules would have settled
otherwise, however firmly those rules are written, and the prompt that began the
turn settles it over both. Rules are what the person set once for everything;
the record is the same person speaking about this Task, and the turn's prompt is
the same person speaking now. Each only overrules an earlier one where the two
speak to the same request. The record is bounded,
and past the bound the oldest entries go. This runs beside the turn rather than
in front of it, so a request that arrives before it finishes is simply one the
person answers.

The record is the person's own sentences and nothing else. It is read and
forgotten from the Task's details, which is the only place it is presented,
and forgetting it cannot be undone: it is rebuilt only from what a person says
next. A prompt sent under any other mode is never sent anywhere.

### Jev Settings

- The rules and the API key live in the data directory's `jev/`, with an
  owner-only directory (`0700`) and file (`0600`); a symbolic link at either
  path is refused. API responses report only whether a key is configured.
- The key is not written to logs or error messages, and TypeSafe's error bodies
  are never read, because the one for a rejected key can repeat part of it.
- Saving a key asks Jev one trivial question so the page can say whether it
  works. That answer is not persisted: a check from a previous run says nothing
  about whether TypeSafe is reachable now.
- Saving or removing the key and writing the rules require a same-origin
  request.
- With no key the mode is withheld, so nothing is sent and every
  request stays the person's.

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
- the mode a session runs under is one of the exclusive `session/new` flags
  Grok accepts — neither, `autoMode`, or `yoloMode` — fixed when the
  conversation is created, and a later prompt asking for another mode is
  refused with that reason;
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

- The browser sends microphone audio only to its same-origin Caffold host.
- The backend bounds duration and request size, accepts only the browser's
  16 kHz mono 16-bit PCM WAV contract, processes samples in memory, and never
  persists raw recordings.
- Whisper transcription is host-local. Its model download starts only from an
  explicit Settings action and uses a pinned URL, byte length, and SHA-256
  checksum.
- When OpenAI, Gemini, or Grok is selected, the backend sends each recording to
  that provider's API with the saved key. Gemini interactions are created with
  `store: false`. Tailscale protects remote transport to the host but is not a
  speech service.
- Saved API keys live in the data directory's `voice/keys.json`, with an
  owner-only directory (`0700`) and file (`0600`); a symbolic link at that path
  is refused. API responses report only whether a key is configured. Keys are
  not written to logs or error messages, and provider error bodies are not
  relayed.
- Downloading or deleting the model, selecting a provider, and saving or
  removing a key require a same-origin request.

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
