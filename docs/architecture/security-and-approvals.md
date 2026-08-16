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
- Distinguish one-time approval from accept-for-session.
- Keep every approval decision visible in the canonical conversation.
- Make decline and cancel first-class outcomes.
- Avoid silent destructive operations.

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
- a one-turn or session grant returns the original server-requested permission
  profile, while denial returns an empty profile;
- command output and exit status remain attached to the canonical turn;
- long-running commands expose visible running state;
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

The optional `caffold tailscale` adapter accepts only an exact localhost HTTP
target. It configures tailnet-only HTTPS Serve and refuses to replace or remove
a different proxy, a shared handler set, or another TCP 443 handler. Tailscale
installation, device authentication, tailnet policy, and HTTPS enablement
remain externally owned.

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
