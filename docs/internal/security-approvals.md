# Security and Approvals

> Internal security boundary for deployment on personal hosts and trusted
> private networks.

Caffold is a remote control surface for a local development machine.

## Trust Boundary

Expected deployment:

- personal host machines
- private network access such as Tailscale
- no public unauthenticated exposure
- browser access to the local filesystem and Codex command execution only
  through the Caffold backend

Caffold should still assume that remote command execution is sensitive.

## Approval Principles

- Show cwd before command approval.
- Show the exact command before approval.
- Distinguish one-time approval from accept-for-session.
- Keep every approval decision visible in the canonical conversation.
- Make decline and cancel first-class outcomes.
- Avoid silent destructive operations.

## Codex Command Execution

Codex app-server owns command execution. Caffold presents each request, command
event, output, and result without introducing a separate command runner or
alternate process state.

Current rules:

- command cwd follows the Codex thread workspace;
- approval cards show the requested command and cwd;
- command output and exit status remain attached to the canonical turn;
- long-running commands expose visible running state;
- approval outcomes are sent back through the original app-server request.

Allowlists, deny lists, or command classes require a separate policy before they
can change the approval flow.

## Git Mutations

Caffold does not expose direct Git mutation controls. Git mutations happen
through Codex instructions or manual terminal work. A future product control
requires an explicit approval and recovery contract.

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

Tailscale reduces exposure but is not a full product security model.

For personal use, it is a practical deployment assumption. If Caffold becomes more broadly used, authentication, authorization, and audit controls need a separate design.

## Voice Input

- Model installation is an explicit first-use action and uses a pinned URL,
  byte length, and SHA-256 checksum.
- The browser sends microphone audio only to its same-origin Caffold host.
- The backend bounds duration and request size, accepts only the browser's
  16 kHz mono 16-bit PCM WAV contract, processes samples in memory, and never
  persists raw recordings.
- Transcription is host-local. Tailscale protects remote transport but is not a
  speech service or inference dependency.
