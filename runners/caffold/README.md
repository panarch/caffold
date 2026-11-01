# caffold-runner

**This crate does not parse what it carries.** It supervises agent child
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
runner          — process supervision, relay or bounded recovery journal
   |  stdio
claude
```

One child per session and one subscribed client per runner. The default
instance uses the data directory beside the database, so an installed
application, a development server, and a test run each get their own. A caller
can select a separate instance with `--socket <directory>/runner.sock`; that
directory also owns its child records. Instances need separate directories as
well as distinct socket names. The subscription is a single connection: every
attached session
delivers its output down it, each event naming its session, and a second client
asking to subscribe is refused while the first still reads. That one connection
is what "the backend" means to the runner, which is what its lifecycle rules
are stated against.

The runner starts in its own process group so a signal sent to Caffold does not
take it along. Its default socket remains `<data-dir>/claude-runner.sock` so
renaming the executable preserves existing Claude sessions. The backend checks
the operating system's Unix-socket path limit before starting it and reports
the path, measured byte length, limit, and corrective action when the configured
data directory is too deep.

The runner ends itself after ten minutes with no subscriber (`daemon run
--idle-timeout`, in seconds; zero disables it). It outlives the backend on
purpose, so a backend that dies without ceremony cannot say so — going
unsubscribed that long is the signal, and the runner leaves by the same door a
deliberate stop uses: children closed, the book of children emptied, the
socket removed. A backend restart reattaches within seconds and never starts
the clock. The backend's `/api/claude/restart` and `/api/antigravity/restart`
stop their respective instance and start a fresh one on the installed binary.

A runner that starts owns nothing from before. Shutting down ends the children
it supervises, but a runner killed outright runs no shutdown code, and its
children would go on with the pipes to them gone — unreachable, and still
writing to conversations the next runner would report as having no session. So
each child is written down as it starts, and a runner ends whatever the last one
left before it answers anything. The previous runner's death has already
closed stdin: startup gives all surviving children one concurrent two-second
EOF cleanup window, then rechecks their process birth identities before
forcing exit. This lets native writers finish without interpreting their
protocol or tracking a process tree.

Frames pass through verbatim. The envelope adds only the session they belong to,
and the frame itself is carried raw so that what the child wrote is what the
client reads.

## Using it

The command line drives relay sessions. Recoverable sessions use the socket
methods described below:

```sh
caffold-runner daemon start --data-dir ~/.caffold
caffold-runner attach --session my-session --cwd /path/to/repo -- \
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

The backend locates `caffold-runner` beside its own executable. Set
`CAFFOLD_RUNNER` to use a different executable during development. A dedicated
instance can be addressed with `caffold-runner daemon status --socket
/path/to/instance/runner.sock`; it uses its own child-record directory and
does not replace the default Claude instance.

## Relay recovery

Claude sessions use relay mode. It keeps no history and nothing about the
conversations it carries. When a client reattaches it receives frames from that moment on, and
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

## Optional output recovery

The socket also offers recoverable sessions. This is an explicit creation
choice; relay creation and Claude's reinitialization path retain their existing
wire contract. `daemon status` advertises `recovery_version: 1` alongside
`protocol_version: 1`, so a client can require the optional methods without
replacing an already running relay daemon.

A recoverable child has one incarnation and a bounded journal of encoded
stdout frames, each with a monotonically increasing sequence. Unacknowledged
frames remain there while connected as well as while disconnected. The driver
supplies an opaque checkpoint string and the output prefix it applied; the
runner replaces them atomically and releases only that prefix. It never parses
the checkpoint or stores a transcript on disk. Stderr stays diagnostic and is
not journaled.

`session_create_recoverable` creates and attaches; `session_attach_recovery`
requires the incarnation listed by the existing session. Both first return a
snapshot with the checkpoint, acknowledged sequence, fixed replay fence, and a
new subscriber lease. Replay begins after that reply. A `replay_fence` event
ends the fixed prefix; `session_replay_live` accepts the checkpoint through
that exact fence before later output and new input may flow. Repeated
disconnects resume from the last accepted checkpoint. Old connection/lease,
different incarnation, regressing acknowledgement, and output not delivered
cannot mutate the state.

`session_send_recovery` reserves stdin capacity, replaces the checkpoint and
enqueues one raw frame in a single acceptance boundary. Its success means
enqueue, not native execution. A full queue refuses both the frame and the
checkpoint; a later pipe-write failure is a journaled `transport_error`. A
client whose send receipt was lost must restore the checkpoint rather than
automatically resend the frame.

The default journal limit is 64 MiB of encoded bytes per child and the maximum
checkpoint is 16 MiB. A caller may lower those limits when creating the child.
The stdout reader stops at capacity until acknowledgement frees space. An
individual encoded frame that cannot fit, invalid stdout, or a read failure
produces an explicit transport error. Natural exit drains stdout before adding
`exit`, and the exited session retains unacknowledged output until explicitly
closed. It is not replaced by a create request. Closing, stopping, the existing
no-subscriber timeout, or replacing the runner discards this memory.
An explicit close retains the session and child record if it cannot confirm
completion, so the caller can retry rather than lose its cleanup reference.

## Tests

`cargo test -p caffold-runner` runs everything the runner is responsible
for against a stand-in agent: relay, survival across a client disconnect,
reattachment, exit reporting, the refusals, and a runner killed outright leaving
nothing behind. It also checks recoverable snapshot/replay/live boundaries,
lost receipts, repeated disconnects, tiny byte budgets, pipe-write failure,
output before Exit, and a new incarnation after runner replacement. It spends
no model usage and is deterministic.

One assumption cannot be checked that way — whether Claude itself still honours
a client that left and came back. That is opt-in, needs an authenticated CLI,
and spends model usage:

```sh
cargo test -p caffold-runner --test live -- --ignored
```
