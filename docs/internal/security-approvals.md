# Security and Approvals

> Internal planning note. This is an early safety model and should be revisited before exposing Caffold beyond personal trusted networks.

Caffold is a remote control surface for a local development machine. Its safety model matters from the first MVP.

## Trust Boundary

Expected deployment:

- personal host machines
- private network access such as Tailscale
- no public unauthenticated exposure
- local filesystem and command access only through the backend

Caffold should still assume that remote command execution is sensitive.

## Approval Principles

- Show cwd before command approval.
- Show the exact command before approval.
- Distinguish one-time approval from accept-for-session.
- Record every approval decision.
- Make decline and cancel first-class outcomes.
- Avoid silent destructive operations.

## Command Runner

The command runner should be explicit and auditable.

MVP rules:

- command cwd is the task worktree
- command output is attached to the task
- exit code is shown
- long-running commands need visible running state
- command start and completion are recorded

Future rules can add allowlists, deny lists, or command classes.

## Git Mutations

Direct git mutation UI is excluded from the MVP.

This avoids making Caffold responsible for complex destructive flows too early. Git mutation can happen through Codex instructions or manual terminal work until a controlled flow is designed.

## Worktree Deletion

Dirty worktree deletion requires explicit confirmation and should be impossible to trigger accidentally.

MVP should prefer no automatic deletion.

## Tailscale Assumption

Tailscale reduces exposure but is not a full product security model.

For personal use, it is a practical deployment assumption. If Caffold becomes more broadly used, authentication, authorization, and audit controls need a separate design.
