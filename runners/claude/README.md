# caffold-claude-runner

**This crate does not parse what it carries.** It supervises `claude` child
processes and moves newline-delimited JSON between them and one client. It
never interprets a frame, never inspects the arguments it spawns, and never
learns a Caffold product concept. Everything it would need to understand in
order to be useful — turns, approvals, models, sessions as the product means
them — belongs to the backend driver above it.

The runner outlives the Caffold backend, so it is the piece that must keep
working across a backend release. Its surface stays small and stable because it
does not depend on the shape of the traffic.

## Why it exists

Codex gives Caffold a persistent app-server daemon, so a Codex turn survives a
backend restart. Claude Code has no equivalent: its programmatic interface is a
child process the host owns over stdio, and a turn ends when that host does.

The runner supplies the missing layer, and what it buys is that restarting
Caffold does not end work already under way. Update the application, or
recover it after a crash, and a Claude turn keeps running: an approval waiting
to be answered stays waiting, and the backend that comes back reattaches to
both. The cost of a restart is a reconnect rather than the work in flight.

## Shape

```text
backend or CLI  — knows the Claude protocol
   |  unix socket, newline-delimited JSON
runner          — process supervision, relay
   |  stdio
claude
```

One child per session, one subscribed client per runner, and one runner per
data directory — the socket lives beside the database, so an installed
application, a development server, and a test run each get their own without
arranging it. The subscription is a single connection: every attached session
delivers its output down it, each event naming its session, and a second client
asking to subscribe is refused while the first still reads. That one connection
is what "the backend" means to the runner, which is what its lifecycle rules
are stated against.

A runner that starts owns nothing from before. Shutting down ends the children
it supervises, but a runner killed outright runs no shutdown code, and its
children would go on with the pipes to them gone — unreachable, and still
writing to conversations the next runner would report as having no session. So
each child is written down as it starts, and a runner ends whatever the last one
left before it answers anything.

Frames pass through verbatim. The envelope adds only the session they belong to,
and the frame itself is carried raw so that what the child wrote is what the
client reads.

## Using it

The command line is the runner's first client, and it can do everything the
backend will:

```sh
caffold-claude-runner daemon start --data-dir ~/.caffold
caffold-claude-runner attach --session my-session --cwd /path/to/repo -- \
  claude -p --input-format stream-json --output-format stream-json --verbose
```

`attach` given a command creates the session and attaches in one request, so
an agent that speaks as soon as it starts is heard; without one it joins a
session that already exists. Its stdin is forwarded to the child and
everything the child produces is written to its stdout, which makes a session
drivable from a shell and reproducible by hand.

`session list` shows what is running, `session close` ends one, and
`daemon status`, `daemon stop`, and `daemon restart` cover the runner itself.
Starting is idempotent at both levels: asking for a runner or a session that
already exists returns the existing one.

## Recovery

The runner keeps no history, and keeps nothing about the conversations it
carries. When a client reattaches it receives frames from that moment on, and
recovering what it missed is the client's job — which the agent gives it three
ways, none of them here:

- `initialize`, re-sent, answers `session_state` — whether a prompt is still
  outstanding — and hands back every unanswered permission and dialog request
  under the identifiers it first gave them.
- The session transcript supplies the conversation.
- The frames that follow supply everything after.

All three are Claude's own, so keeping any of it here would be a second copy to
hold in step with the first.

A child that exits stays listed as `exited` rather than being restarted or
dropped. The conversation is on disk, so the backend recovers by asking for the
session again with arguments that resume it.

## Tests

`cargo test -p caffold-claude-runner` runs everything the runner is responsible
for against a stand-in agent: relay, survival across a client disconnect,
reattachment, exit reporting, the refusals, and a runner killed outright leaving
nothing behind. It spends no model usage and is deterministic.

One assumption cannot be checked that way — whether Claude itself still honours
a client that left and came back. That is opt-in, needs an authenticated CLI,
and spends model usage:

```sh
cargo test -p caffold-claude-runner --test live -- --ignored
```
