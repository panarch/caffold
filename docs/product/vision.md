# Vision

Caffold started with a fairly personal observation: I had stopped typing much
code. A coding agent was doing more of that work, but I was reading more code
than before, checking diffs and test results, deciding whether the result made
sense, and explaining what should happen next.

That was a good change—I could get more work done—but the part that still
needed me was tied to the same terminal and desk. When foldable phones became
wide enough to read a meaningful diff, it seemed reasonable to ask whether the
rest of the loop could travel with me too.

The first useful piece was a code and diff viewer. It was meant for a phone,
but it was also more comfortable than expected on a desktop. From there the
scope became clearer: a viewer alone was not enough. To do real work, the same
place also needed the agent conversation, approvals, command results, Task
state, and a way to give the next instruction.

I initially expected this could be a lightweight companion to an existing
agent client. In practice, a live coding-agent session is not something
independent clients can casually share. Caffold therefore keeps its own Task
surface connected to each supported agent's programmatic runtime on one
trusted host. It does not pretend that the work itself has moved onto the
phone.

## The basic idea

The Mac runs Caffold, the selected coding agent, and Git. A browser or installed
PWA on any device shows the same Caffold Tasks and lets the developer continue
the loop:

```text
ask for work
    -> see what the agent is doing
    -> inspect the code, diff, commands, and tests
    -> approve, interrupt, or give the next instruction
    -> inspect again
```

Git remains the source of truth for code. The selected agent remains the
source of truth for its conversation and execution. Caffold's job is to keep
those pieces connected and readable, not to create a second version of either
one.

## The model and harness belong together

A coding agent is not just a model endpoint. Its harness decides which tools
exist, how context is gathered, how permissions are requested, how a turn is
steered or interrupted, how sessions survive, and how new capabilities reach
the user. That behavior is a material part of the agent.

Caffold therefore supports Codex and Claude Code through separate native
drivers. It connects to Codex app-server as Codex's own clients do, and it
drives Claude Code through the CLI protocol and transcript Claude itself owns.
Caffold adds the supervision required by its host lifecycle, but does not
replace either harness with a generic one.

The interface shares only concepts that have a stable Caffold meaning—Task,
Conversation, turn, activity, approval, and review context. Agent-specific
models, modes, tools, wire messages, readiness, and process behavior stay with
the agent-specific driver. A new feature should reach the product at its native
fidelity first; portability is useful only when it preserves what the feature
means.

This is why multi-agent support is not a runtime plugin API or a promise that
every agent behaves identically. It is a way to give more than one first-class
harness the same review-centered workspace without reducing either one to a
common protocol's smallest subset. The implemented boundary is described in
[Agent runtimes](../architecture/agent-runtimes.md).

## What Caffold should make easier

- Begin in an ordinary checkout without setup ceremony.
- Choose the native agent that fits the work when a Task begins.
- Leave a longer Task running and return without reconstructing its context.
- Read the actual changes instead of relying only on an assistant's summary.
- Use the same workflow on a desktop, foldable, tablet, or phone instead of a
  separate reduced companion surface.
- Give direction by text, images, or host-local voice input.
- Create an isolated worktree when separation is useful, without making it a
  prerequisite for every Task.

The browser is a practical choice here. It gives Caffold one responsive
interface across devices and lets each device install that interface as a PWA.
The layout can adapt without changing the kind of work available: desktop,
foldable, and tablet are first-class ways to use the whole workspace. A phone
shows less at once, but it stays connected to the same Task and workflow rather
than becoming a separate lightweight product.

Caffold is meant to remain self-hosted as that access expands: execution,
repositories, credentials, and data stay on a host the developer controls. A
Caffold-operated managed service is not planned.

## What should stay true as it grows

Caffold is not an autonomous agent orchestrator. The developer is expected to
read, judge, and redirect the work. A Task belongs to one agent rather than
silently changing harnesses mid-conversation.

It is also not trying to reproduce an IDE, terminal, agent harness, or full Git
and GitHub client on every screen. Direct controls belong in Caffold when they
make a repeated review step clearer or safer. Everything else can stay with the
selected agent and the existing developer tools.

Today Caffold assumes one trusted user, one trusted host, and local or
tailnet-only access. The roadmap includes fully supported, authenticated
internet-facing self-hosting. That requires a different security model, but it
does not change who owns the host or turn Caffold into a managed service.

The aim stays concrete: let the user's machine keep doing the mechanical part
while the developer can read, decide, and continue the work from whichever
screen is at hand.
