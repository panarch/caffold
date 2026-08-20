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
- browser access to the local filesystem and Codex command execution only
  through the Caffold backend

Caffold should still assume that remote command execution is sensitive.

## Approval Principles

- Show the cwd and exact command when a command approval supplies them.
- Show the complete requested capability profile before permission approval.
- Distinguish allowing once from allowing always.
- Keep every approval decision visible in the canonical conversation.
- Make refusal a first-class outcome, both when the turn continues and when it
  stops.
- Avoid silent destructive operations.

## The Approval Vocabulary

Caffold offers four answers to any approval: allow, allow always, deny, and deny
and stop. A request advertises which of them it accepts, and answering with one
it did not offer is refused before anything reaches the agent.

Caffold owns the answer, not the permission. Allowing something always tells the
agent to apply the grant the agent itself proposed, so the permission model
stays the agent's and Caffold never composes one.

A request reaches the interface already written for a person to read: a title, a
reason, and whichever specifics it carries — the command, the working directory,
the network destination, the requested access as labelled rows. The driver
writes those, because reading a permission profile means understanding it, and
the driver is what understands its own agent.

An approval's identity is Caffold's; the request it must be answered on is the
agent's. The driver holds the pairing between the two, so nothing above it
carries a protocol id, and taking that pairing is what retires the approval —
whether a person answered it here or the agent resolved it first. Each pairing
is taken once, so an approval is never answered or withdrawn twice.

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

## Git Mutations

Caffold does not expose direct Git mutation controls. Git mutations happen
through Codex instructions or manual terminal work.

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
- Push delivery failure never changes canonical Task state or foreground SSE
  behavior.
