# Vision

Caffold started with a fairly personal observation: I had stopped typing much
code. Codex was doing more of that work, but I was reading more code than
before, checking diffs and test results, deciding whether the result made
sense, and explaining what should happen next.

That was a good change—I could get more work done—but the part that still
needed me was tied to the same terminal and desk. When foldable phones became
wide enough to read a meaningful diff, it seemed reasonable to ask whether the
rest of the loop could travel with me too.

The first useful piece was a code and diff viewer. It was meant for a phone,
but it was also more comfortable than expected on a desktop. From there the
scope became clearer: a viewer alone was not enough. To do real work, the same
place also needed the Codex conversation, approvals, command results, Task
state, and a way to give the next instruction.

I initially expected this could be a lightweight companion to an existing
Codex client. In practice, a Codex session is not something independent clients
can casually share at the same time. Caffold therefore keeps its own Task
surface connected to Codex app-server on one trusted host. It does not pretend
that the work itself has moved onto the phone.

## The basic idea

The Mac runs Caffold, Codex, and Git. A browser or installed PWA on any device
shows the same Caffold Tasks and lets the developer continue the loop:

```text
ask for work
    -> see what Codex is doing
    -> inspect the code, diff, commands, and tests
    -> approve, interrupt, or give the next instruction
    -> inspect again
```

Git remains the source of truth for code. Codex app-server remains the source
of truth for its threads and turns. Caffold's job is to keep those pieces
connected and readable, not to create a second version of either one.

## What Caffold should make easier

- Begin in an ordinary checkout without setup ceremony.
- Leave a longer Task running and return without reconstructing its context.
- Read the actual changes instead of relying only on an assistant's summary.
- Use the same workflow on a large monitor, laptop, foldable, or phone.
- Give direction by text, images, or host-local voice input.
- Create an isolated worktree when separation is useful, without making it a
  prerequisite for every Task.

The browser is a practical choice here. It gives Caffold one responsive
interface across devices and lets each device install that interface as a PWA.
It is not an attempt to make the product cloud-hosted: the trusted Mac still
owns execution, repositories, credentials, and data.

## What it is not trying to become

Caffold is not an autonomous agent orchestrator. The developer is expected to
read, judge, and redirect the work.

It is also not trying to reproduce an IDE, terminal, or full Git and GitHub
client on every screen. Direct controls belong in Caffold when they make a
repeated review step clearer or safer. Everything else can stay with Codex and
the existing developer tools.

Public hosting and multi-user collaboration require a different security
model. Caffold currently assumes one trusted user, one trusted host, and local
or tailnet-only access. That limit is part of the current product, not a claim
that a browser interface is secure wherever it is exposed.

The goal is modest: let the machine keep doing the mechanical part while the
developer can read, decide, and continue the work from whichever screen is at
hand.
