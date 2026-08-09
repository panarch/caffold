# Vision

Caffold is scaffolding for agent-assisted development: a browser-based review
and control surface optimized for a review-first development loop.

It is not an orchestration layer for handing work to an agent and waiting for a
finished result. The agent works, the developer inspects the actual changes and
evidence, and the next instruction follows from that review.

Codex is the current execution engine. Git worktrees remain the source of truth
for code changes. Caffold keeps the work visible, makes it easier to guide, and
leaves the decision about what is safe to keep with the developer.

## Product Bet

Agent-assisted development shifts more of the coding loop toward reviewing,
questioning, approving, and redirecting work. The developer still makes the
judgment calls, but no longer needs to perform every underlying operation by
hand.

That loop should remain practical away from a desk. Foldable phones and wider
mobile displays are large enough to inspect meaningful code changes, while a
browser or PWA can connect the reviewer to work running on a
developer-controlled host.

Caffold's product bet is that a focused review surface can make this loop
comfortable across desktop, mobile, and foldable devices without reproducing a
full IDE on every screen.

## Review-First Loop

The core loop is deliberately simple:

```text
request work
    -> inspect the Task, files, diff, commands, and test evidence
    -> approve, interrupt, or provide the next instruction
    -> inspect the resulting work again
```

Caffold should make it comfortable to:

- send a prompt or follow-up instruction;
- see which Task, Codex thread, repository, and worktree are connected;
- inspect changed files, diffs, and surrounding source;
- review command and test results;
- approve or decline sensitive actions;
- interrupt work that is heading in the wrong direction;
- return later without losing orientation.

An existing checkout is enough to begin. Isolated worktrees are an optional
tool for separating longer or concurrent tasks, not a requirement for using
Caffold.

## Interaction Principle

Caffold favors natural-language direction over reproducing terminal, Git, and
GitHub interfaces. Natural language reduces the control surface; it does not
reduce developer oversight or hide the underlying work.

Direct product controls belong where they improve visibility, safety, or a
repeated review workflow. Caffold can add narrow lifecycle operations such as
approval, interruption, worktree preparation, and archive without becoming a
general terminal, editor, or mutation-heavy Git client.

## Positioning

Caffold is for developers who:

- rely on coding agents for substantial development work;
- want to inspect actual changes rather than trust a final summary;
- manage longer tasks across repositories, checkouts, and optional isolated
  worktrees;
- want the same review loop to remain practical across devices;
- prefer a focused review and control surface over a full IDE.

## Non-Goals

Caffold is not:

- an autonomous coding agent or hands-off agent orchestrator;
- an IDE or source-code editor;
- a full terminal workspace;
- a full Git or GitHub mutation interface;
- a native Android or iOS application;
- a replacement for the richer desktop agent experience;
- a second source of truth for agent, Git, or GitHub state.

Caffold complements richer agent interfaces with a focused surface for
inspecting, guiding, and validating development work wherever the developer is
reviewing it.
